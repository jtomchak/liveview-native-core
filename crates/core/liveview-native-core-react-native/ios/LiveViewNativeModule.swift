import ExpoModulesCore
import Foundation
import CoreFoundation
import Security
import CryptoKit

@Record
fileprivate struct LiveViewNativeUpdate {
  var sessionId: String
  var revision: Int
  var documentGeneration: Int
  var status: String
  var document: String?
  var documentKind: String
  var documentRevision: Int
  var baseDocumentRevision: Int?
  var documentPatch: String?
  var patchBytes: Int?
  var fullSnapshotBytes: Int?
  var coalescedCallbacks: Int
  var error: String?
  var snapshotMs: Double?
  var snapshotBytes: Int?
  var callbackCount: Int
  var clearDocument: Bool
}

@ExpoModule("LiveViewNative")
public final class LiveViewNativeModule: Module {
  private let lock = NSLock()
  private var sessions: [String: NativeSession] = [:]
  private var stores: [String: NativeCookieStore] = [:]
  private var signingOut: Set<String> = []

  // Keep the original JS event name: the default @Event name would strip "on".
  @Event("onUpdate")
  fileprivate var onUpdate: (LiveViewNativeUpdate) -> Void

  // UniFFI setup, payload conversion and shutdown stay off the JavaScript thread.
  @JS(.concurrent)
  func connect(_ id: String, _ url: String) async throws {
    guard let address = URL(string: url), ["http", "https"].contains(address.scheme ?? ""),
          address.host != nil else {
      throw BridgeError.invalidURL
    }
    let origin = try normalizedOrigin(url)
    let store = try lock.withLock { () throws -> NativeCookieStore in
      guard !signingOut.contains(origin) else { throw BridgeError.disconnected }
      if let store = stores[origin] { return store }
      let store = NativeCookieStore(origin: origin)
      stores[origin] = store
      return store
    }
    try store.checkFailure()
    let session = NativeSession(id: id, origin: origin, store: store, module: self)
    let old = try self.lock.withLock { () throws -> NativeSession? in
      guard !signingOut.contains(origin), stores[origin] === store else { throw BridgeError.disconnected }
      return self.sessions.updateValue(session, forKey: id)
    }
    old?.close()
    session.publish(status: "connecting")
    let builder = LiveViewClientBuilder()
    builder.setFormat(.reactNative)
    builder.setPersistenceProvider(store)
    builder.setNavigationHandler(NavigationCallbacks(session))
    let callbacks = SessionCallbacks(session)
    builder.setLiveChannelEventHandler(callbacks)
    do {
      let client = try await builder.connect(url, ClientConnectOpts())
      session.install(client)
      try store.checkFailure()
    } catch {
      session.publish(status: "error", error: String(describing: error))
      if store.hasFailure { session.close() }
      throw error
    }
  }

  @JS(.concurrent)
  func sendEvent(_ id: String, _ event: String, _ valueJSON: String) async throws {
    guard let session = self.lock.withLock({ self.sessions[id] }),
          let client = session.connectedClient() else { throw BridgeError.disconnected }
    guard let bytes = valueJSON.data(using: .utf8),
          let values = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
    else { throw BridgeError.invalidPayload }
    let value = try nativeJSON(values)
    let payload = Json.object(object: [
      "type": .str(string: "click"), "event": .str(string: event), "value": value
    ])
    do {
      _ = try await client.call("event", .jsonPayload(json: payload))
      try session.store.checkFailure()
    } catch {
      session.publish(status: "error", error: String(describing: error))
      throw error
    }
  }

  @JS(.concurrent)
  func callEvent(_ id: String, _ event: String, _ valueJSON: String) async throws -> String {
    guard let session = lock.withLock({ sessions[id] }), let client = session.connectedClient()
    else { throw BridgeError.disconnected }
    let generation = session.connectionState().generation
    do {
      guard !event.isEmpty, event.utf8.count <= 128, valueJSON.utf8.count <= 16_384,
            let bytes = valueJSON.data(using: .utf8),
            let values = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
      else { throw BridgeError.invalidPayload }
      let payload = Json.object(object: [
        "type": .str(string: "click"), "event": .str(string: event), "value": try nativeJSON(values)
      ])
      let wireReply = try await client.call("event", .jsonPayload(json: payload))
      try session.store.checkFailure()
      let reply = try jsonReplyString(wireReply)
      guard reply.utf8.count <= 16_384 else { throw BridgeError.invalidPayload }
      return reply
    } catch {
      if session.store.hasFailure {
        session.publish(status: "error", error: "Secure cookie storage failed", expectedGeneration: generation)
      }
      // Business command rejection leaves the transport available for retry.
      throw BridgeError.commandFailed
    }
  }

  @JS(.concurrent)
  func sendForm(_ id: String, _ event: String, _ encodedValue: String, _ cid: Double?) async throws -> String {
    guard !event.isEmpty, event.utf8.count <= 128, encodedValue.utf8.count <= 262_144
    else { throw BridgeError.invalidPayload }
    guard let session = lock.withLock({ sessions[id] }), let client = session.connectedClient()
    else { throw BridgeError.disconnected }
    var fields: [String: Json] = [
      "type": .str(string: "form"), "event": .str(string: event),
      "value": .str(string: encodedValue)
    ]
    if let cid {
      guard cid.isFinite, cid >= 1, cid <= 9_007_199_254_740_991, cid.rounded(.towardZero) == cid
      else { throw BridgeError.invalidPayload }
      fields["cid"] = .numb(number: .posInt(pos: UInt64(cid)))
    }
    let generation = session.connectionState().generation
    do {
      // This acknowledges the channel call, not business-record persistence.
      let reply = try await client.call("event", .jsonPayload(json: .object(object: fields)))
      try session.store.checkFailure()
      return try jsonReplyString(reply)
    } catch {
      session.publish(status: "error", error: "Form event failed", expectedGeneration: generation)
      // Neither form values nor server error payloads cross this error boundary.
      throw BridgeError.formFailed
    }
  }

  @JS(.concurrent)
  func uploadFile(_ id: String, _ fieldName: String, _ uri: String, _ fileName: String, _ mimeType: String) async throws {
    guard let session = lock.withLock({ sessions[id] }), let client = session.connectedClient()
    else { throw BridgeError.disconnected }
    let generation = session.connectionState().generation
    do {
      guard !fieldName.isEmpty, fieldName.utf8.count <= 128,
            ["image/png", "text/plain"].contains(mimeType) else { throw BridgeError.invalidPayload }
      let basename = try uploadBasename(fileName)
      let contents = try readUpload(uri)
      let state = session.connectionState()
      guard !state.closed, state.generation == generation, state.status == "connected"
      else { throw BridgeError.disconnected }
      let uploadId = try client.getPhxUploadId(fieldName)
      let file = LiveFile(contents, mimeType, fieldName, basename, uploadId)
      // Transfer completion does not consume the entry or save an attachment.
      try await client.uploadFiles([file])
      try session.store.checkFailure()
    } catch {
      // Rejected selections/transfers remain retryable; connection callbacks
      // own connection status. Secure storage failures require session cleanup.
      if session.store.hasFailure {
        session.publish(status: "error", error: "Secure cookie storage failed", expectedGeneration: generation)
      }
      throw BridgeError.uploadFailed
    }
  }

  @JS(.concurrent)
  func cancelUpload(_ id: String, _ fieldName: String, _ entryRef: String) async throws {
    guard let session = lock.withLock({ sessions[id] }), let client = session.connectedClient()
    else { throw BridgeError.disconnected }
    let generation = session.connectionState().generation
    do {
      guard !fieldName.isEmpty, fieldName.utf8.count <= 128,
            !entryRef.isEmpty, entryRef.utf8.count <= 128 else { throw BridgeError.invalidPayload }
      try await client.cancelUpload(fieldName)
      let state = session.connectionState()
      guard !state.closed, state.generation == generation, state.status == "connected"
      else { throw BridgeError.disconnected }
      let payload = Json.object(object: [
        "type": .str(string: "click"), "event": .str(string: "cancel_upload"),
        "value": .object(object: ["ref": .str(string: entryRef)])
      ])
      _ = try await client.call("event", .jsonPayload(json: payload))
      try session.store.checkFailure()
    } catch {
      if session.store.hasFailure {
        session.publish(status: "error", error: "Secure cookie storage failed", expectedGeneration: generation)
      }
      throw BridgeError.uploadFailed
    }
  }

  @JS(.concurrent)
  func postForm(_ id: String, _ url: String, _ fieldsJSON: String) async throws {
    guard let session = lock.withLock({ sessions[id] }) else { throw BridgeError.disconnected }
    try await submitForm(session, url: url, fieldsJSON: fieldsJSON)
  }

  @JS(.concurrent)
  func navigate(_ id: String, _ url: String, _ replace: Bool) async throws {
    guard let session = lock.withLock({ sessions[id] }),
          let client = session.connectedClient() else { throw BridgeError.disconnected }
    guard try normalizedOrigin(url) == session.origin else { throw BridgeError.invalidURL }
    // The return acknowledges queued navigation; onUpdate carries its document commit.
    _ = try client.navigate(url, NavOptions(action: replace ? .replace : .push))
  }

  @JS(.concurrent)
  func back(_ id: String) async throws {
    guard let client = lock.withLock({ sessions[id] })?.connectedClient()
    else { throw BridgeError.disconnected }
    _ = try client.back(NavActionOptions())
  }

  @JS(.concurrent)
  func forward(_ id: String) async throws {
    guard let client = lock.withLock({ sessions[id] })?.connectedClient()
    else { throw BridgeError.disconnected }
    _ = try client.forward(NavActionOptions())
  }

  @JS(.concurrent)
  func getNavigation(_ id: String) async throws -> String {
    guard let session = lock.withLock({ sessions[id] }), let client = session.connectedClient()
    else { throw BridgeError.disconnected }
    let current = client.current()
    let payload: [String: Any] = [
      "url": current?.url as Any? ?? NSNull(),
      // History IDs are u64; strings avoid JavaScript integer precision loss.
      "historyId": current.map { String($0.id) } as Any? ?? NSNull(),
      "action": session.navigationAction() as Any? ?? NSNull(),
      "canGoBack": client.canGoBack(), "canGoForward": client.canGoForward()
    ]
    return String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self)
  }

  @JS(.concurrent)
  func logout(_ id: String, _ url: String) async throws {
    guard let session = lock.withLock({ sessions[id] }) else { throw BridgeError.disconnected }
    guard try normalizedOrigin(url) == session.origin else { throw BridgeError.invalidURL }
    try lock.withLock {
      guard signingOut.insert(session.origin).inserted else { throw BridgeError.disconnected }
    }
    defer { lock.withLock { signingOut.remove(session.origin) } }
    var failure: Error?
    do { try await submitForm(session, url: url, fieldsJSON: "{}") }
    catch { failure = error }
    session.store.disableWrites()
    // Reclaim every in-memory jar before removing the durable cookie cache.
    let closing = lock.withLock { () -> [NativeSession] in
      let closing = sessions.values.filter { $0.origin == session.origin }
      closing.forEach { sessions.removeValue(forKey: $0.id) }
      return closing
    }
    closing.forEach {
      let update = $0.invalidationUpdate()
      // Removed sessions deliberately bypass the normal identity guard so every
      // mounted consumer can discard its protected document after logout.
      DispatchQueue.main.async { [weak self] in self?.onUpdate(update) }
      $0.close()
    }
    session.store.removeEntry("COOKIE_CACHE")
    lock.withLock { stores.removeValue(forKey: session.origin) }
    try session.store.checkFailure()
    if let failure { throw failure }
  }

  private func submitForm(_ session: NativeSession, url: String, fieldsJSON: String) async throws {
    guard try normalizedOrigin(url) == session.origin else { throw BridgeError.invalidURL }
    guard let data = fieldsJSON.data(using: .utf8),
          let fields = try JSONSerialization.jsonObject(with: data) as? [String: String]
    else { throw BridgeError.invalidPayload }
    guard let client = session.connectedClient() else { throw BridgeError.disconnected }
    let generation = session.connectionState().generation
    try await client.postForm(url, fields, nil, nil)
    // Rust queues reconnect; its async return is not an HTTP commit acknowledgement.
    let deadline = ProcessInfo.processInfo.systemUptime + 30
    while ProcessInfo.processInfo.systemUptime < deadline {
      try session.store.checkFailure()
      let state = session.connectionState()
      if state.closed { throw BridgeError.disconnected }
      if state.status == "error" { throw BridgeError.formFailed }
      if state.status == "connected", state.generation > generation { return }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    throw BridgeError.formTimeout
  }

  @JS(.concurrent)
  func requestSnapshot(_ id: String) async throws {
    guard let session = lock.withLock({ sessions[id] }) else { throw BridgeError.disconnected }
    try await session.requestSnapshot()
  }

  @JS(.concurrent)
  func disconnect(_ id: String) async {
    let session = lock.withLock { sessions.removeValue(forKey: id) }
    session?.close()
  }

  public override func willDestroy() {
    let current = lock.withLock { () -> [NativeSession] in
      let current = Array(sessions.values)
      sessions.removeAll()
      return current
    }
    current.forEach { $0.close() }
  }

  fileprivate func deliver(_ update: LiveViewNativeUpdate, for session: NativeSession) {
    DispatchQueue.main.async { [weak self, weak session] in
      guard let self, let session,
            self.lock.withLock({ self.sessions[session.id] === session }) else { return }
      self.onUpdate(update)
    }
  }
}

private enum BridgeError: Error {
  case invalidURL, invalidPayload, disconnected, formFailed, formTimeout, uploadFailed, commandFailed, secureStorageFailure(OSStatus)
}

private let maxUploadBytes = 2 * 1024 * 1024

private func uploadBasename(_ fileName: String) throws -> String {
  let basename = fileName.replacingOccurrences(of: "\\", with: "/").components(separatedBy: "/").last ?? ""
  let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._ -"))
  let sanitized = String(String.UnicodeScalarView(basename.unicodeScalars.map {
    allowed.contains($0) ? $0 : UnicodeScalar("_")
  })).trimmingCharacters(in: CharacterSet(charactersIn: ". "))
  guard !sanitized.isEmpty, sanitized.utf8.count <= 128 else { throw BridgeError.invalidPayload }
  return sanitized
}

private func readUpload(_ uri: String) throws -> Data {
  guard let url = URL(string: uri), url.isFileURL,
        url.host == nil || url.host == "" || url.host == "localhost",
        try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true
  else { throw BridgeError.invalidPayload }
  let file = try FileHandle(forReadingFrom: url)
  defer { try? file.close() }
  var data = Data()
  while data.count <= maxUploadBytes {
    let chunk = try file.read(upToCount: min(65_536, maxUploadBytes + 1 - data.count)) ?? Data()
    if chunk.isEmpty { break }
    data.append(chunk)
  }
  guard !data.isEmpty, data.count <= maxUploadBytes else { throw BridgeError.invalidPayload }
  return data
}

private func normalizedOrigin(_ address: String) throws -> String {
  guard let url = URL(string: address), let scheme = url.scheme?.lowercased(),
        ["http", "https"].contains(scheme), let host = url.host?.lowercased(),
        url.user == nil, url.password == nil else { throw BridgeError.invalidURL }
  return "\(scheme)://\(host):\(url.port ?? (scheme == "https" ? 443 : 80))"
}

private final class NavigationCallbacks: NavEventHandler {
  private weak var session: NativeSession?
  init(_ session: NativeSession) { self.session = session }
  func handleEvent(_ event: NavEvent) -> HandlerResponse {
    // Covers server-driven navigation as well as the JS navigate method.
    guard let session, (try? normalizedOrigin(event.to.url)) == session.origin else { return .preventDefault }
    return session.recordNavigationAction(event.event) ? .default : .preventDefault
  }
}

// UniFFI's synchronous callbacks cannot throw. Record failures and surface them
// through native promises and status updates instead of silently losing cookies.
private final class NativeCookieStore: SecurePersistentStore {
  private let lock = NSLock()
  private let service: String
  private var failure: OSStatus?
  private var disabled = false
  init(origin: String) {
    service = "org.liveviewnative.cookies." + SHA256.hash(data: Data(origin.utf8)).map {
      String(format: "%02x", $0)
    }.joined()
  }
  func checkFailure() throws {
    if let failure = lock.withLock({ failure }) { throw BridgeError.secureStorageFailure(failure) }
  }
  var hasFailure: Bool { lock.withLock { failure != nil } }
  func disableWrites() { lock.withLock { disabled = true } }
  private func query(_ key: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
     kSecAttrAccount as String: key]
  }
  func get(_ key: String) -> Data? {
    lock.withLock {
      if disabled { return nil }
      var query = query(key)
      query[kSecReturnData as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      if status == errSecItemNotFound { return nil }
      if status != errSecSuccess { failure = status; return nil }
      guard let data = result as? Data else { failure = errSecDecode; return nil }
      return data
    }
  }
  func set(_ key: String, _ value: Data) {
    lock.withLock {
      if disabled { return }
      let attributes: [String: Any] = [kSecValueData as String: value,
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
      var status = SecItemUpdate(query(key) as CFDictionary, attributes as CFDictionary)
      if status == errSecItemNotFound {
        status = SecItemAdd(query(key).merging(attributes) { _, new in new } as CFDictionary, nil)
      }
      if status != errSecSuccess { failure = status }
    }
  }
  func removeEntry(_ key: String) {
    lock.withLock {
      let status = SecItemDelete(query(key) as CFDictionary)
      if status != errSecSuccess && status != errSecItemNotFound { failure = status }
      else { failure = nil }
    }
  }
}

// Rust holds the callback proxy, not this session. This breaks the
// client -> callback -> session -> client ownership cycle.
private final class SessionCallbacks: NetworkEventHandler {
  private weak var session: NativeSession?
  init(_ session: NativeSession) { self.session = session }
  func onEvent(_ event: EventPayload) {}
  func onStatusChange(_ status: LiveViewClientStatus) {
    switch status {
    case .disconnected: session?.publish(status: "disconnected")
    case .connecting: session?.publish(status: "connecting")
    case .reconnecting: session?.publish(status: "reconnecting")
    case .error(let error): session?.publish(status: "error", error: String(describing: error))
    case .connected(let channelStatus):
      switch channelStatus {
      case .connected(let document): session?.publish(status: "connected", document: document)
      case .reconnecting: session?.publish(status: "reconnecting")
      }
    }
  }
}

// Bind callbacks to one document generation. An old document can still finish
// a callback after replacement; it must not publish against the new document.
private final class DocumentCallbacks: DocumentChangeHandler {
  private weak var session: NativeSession?
  private let generation: Int
  init(_ session: NativeSession, generation: Int) {
    self.session = session
    self.generation = generation
  }
  func handleDocumentChange(_ changeType: ChangeType, _ nodeRef: NodeRef,
                            _ nodeData: NodeData, _ parent: NodeRef?) {
    session?.publish(documentChanged: true, expectedGeneration: generation)
  }
}

private final class NativeSession: @unchecked Sendable {
  let id: String
  let origin: String
  let store: NativeCookieStore
  private weak var module: LiveViewNativeModule?
  private let lock = NSLock()
  private var client: LiveViewClient?
  private var document: Document?
  private var documentIdentity: UInt64?
  private var documentGeneration = 0
  private var status = "connecting"
  private var revision = 0
  private var callbackCount = 0
  private var closed = false
  private var lastNavigationAction: String?
  private let deliveries = DispatchQueue(label: "org.liveviewnative.document", qos: .utility)
  private var documentRevision = 0
  private var baseline: NormalizedSnapshot?
  private var pending: DispatchWorkItem?
  private var pendingToken = 0
  private var pendingCallbacks = 0

  init(id: String, origin: String, store: NativeCookieStore, module: LiveViewNativeModule) {
    self.id = id; self.origin = origin; self.store = store; self.module = module
  }

  func connectionState() -> (generation: Int, status: String, closed: Bool) {
    lock.withLock { (documentGeneration, status, closed) }
  }

  func recordNavigationAction(_ action: NavEventType) -> Bool {
    lock.withLock {
      guard !closed else { return false }
      switch action {
      case .push: lastNavigationAction = "push"
      case .replace: lastNavigationAction = "replace"
      case .traverse: lastNavigationAction = "traverse"
      case .patch: lastNavigationAction = "patch"
      case .reload: lastNavigationAction = "reload"
      }
      return true
    }
  }

  func navigationAction() -> String? { lock.withLock { lastNavigationAction } }

  private func resetBaseline() {
    pending?.cancel()
    pending = nil
    pendingToken += 1
    pendingCallbacks = 0
    baseline = nil
  }

  private func statusUpdate(error: String? = nil, clear: Bool = false, deliveryStatus: String? = nil) -> LiveViewNativeUpdate {
    revision += 1
    return LiveViewNativeUpdate(sessionId: id, revision: revision,
      documentGeneration: documentGeneration, status: store.hasFailure && !clear ? "error" : (deliveryStatus ?? status), document: nil,
      documentKind: "status", documentRevision: documentRevision,
      baseDocumentRevision: nil, documentPatch: nil, patchBytes: nil,
      fullSnapshotBytes: nil, coalescedCallbacks: 0,
      error: store.hasFailure ? "Secure cookie storage failed" : error,
      snapshotMs: nil, snapshotBytes: nil, callbackCount: callbackCount, clearDocument: clear)
  }

  func invalidationUpdate() -> LiveViewNativeUpdate {
    lock.withLock {
      resetBaseline()
      document = nil
      documentIdentity = nil
      status = "disconnected"
      return statusUpdate(clear: true)
    }
  }

  func install(_ client: LiveViewClient) {
    let accepted = lock.withLock { () -> Bool in
      guard !closed else { return false }
      self.client = client
      return true
    }
    // Rust's status callback supplies the actual connected/error state and
    // document. Initial connect may finish in an error state without throwing.
    if !accepted { client.shutdown() }
  }

  func connectedClient() -> LiveViewClient? {
    lock.withLock { !closed && status == "connected" ? client : nil }
  }

  func publish(status: String? = nil, document: Document? = nil, error: String? = nil,
               documentChanged: Bool = false, expectedGeneration: Int? = nil) {
    lock.withLock {
      guard !closed else { return }
      if let expectedGeneration, expectedGeneration != documentGeneration { return }
      if let status { self.status = status }
      if store.hasFailure { self.status = "error" }
      if let document {
        let identity = document.identity()
        let replaced = documentIdentity != identity
        if replaced {
          documentGeneration += 1
          documentIdentity = identity
          resetBaseline()
        }
        self.document = document
        document.setEventHandler(DocumentCallbacks(self, generation: documentGeneration))
        if replaced || baseline == nil {
          let generation = documentGeneration
          let connectedStatus = self.status
          deliveries.async { [weak self] in
            self?.emitSnapshot(generation: generation, identity: identity, forceFull: replaced, callbacks: 0, deliveryStatus: connectedStatus)
          }
          return
        }
      }
      if documentChanged { callbackCount += 1 }
      if documentChanged && !store.hasFailure {
        pendingCallbacks += 1
        if pending == nil, let identity = documentIdentity {
          pendingToken += 1
          let token = pendingToken
          let generation = documentGeneration
          let work = DispatchWorkItem { [weak self] in
            self?.flush(generation: generation, identity: identity, token: token)
          }
          pending = work
          deliveries.asyncAfter(deadline: .now() + .milliseconds(8), execute: work)
        }
        return
      }
      // All ordinary status and document events share the serial queue. Assign
      // event revisions there, so a status cannot overtake a new-generation full.
      let generation = documentGeneration
      let deliveryStatus = self.status
      deliveries.async { [weak self] in
        guard let self else { return }
        let shouldClose = self.lock.withLock { () -> Bool in
          guard !self.closed, self.documentGeneration == generation else { return false }
          self.module?.deliver(self.statusUpdate(error: error, deliveryStatus: deliveryStatus), for: self)
          return self.store.hasFailure
        }
        if shouldClose { self.close() }
      }
    }
  }

  private func flush(generation: Int, identity: UInt64, token: Int) {
    let callbacks = lock.withLock { () -> Int? in
      guard !closed, documentGeneration == generation, documentIdentity == identity,
            pendingToken == token else { return nil }
      pending = nil
      let callbacks = pendingCallbacks
      pendingCallbacks = 0
      return callbacks
    }
    if let callbacks { emitSnapshot(generation: generation, identity: identity, forceFull: false, callbacks: callbacks) }
  }

  func requestSnapshot() async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      deliveries.async { [weak self] in
        guard let self else { continuation.resume(throwing: BridgeError.disconnected); return }
        let state = self.lock.withLock { () -> (Int, UInt64, Int)? in
          guard !self.closed, self.document != nil, let identity = self.documentIdentity else { return nil }
          self.pending?.cancel()
          self.pending = nil
          self.pendingToken += 1
          let callbacks = self.pendingCallbacks
          self.pendingCallbacks = 0
          return (self.documentGeneration, identity, callbacks)
        }
        guard let state, self.emitSnapshot(generation: state.0, identity: state.1, forceFull: true, callbacks: state.2)
        else { continuation.resume(throwing: BridgeError.disconnected); return }
        continuation.resume()
      }
    }
  }

  @discardableResult
  private func emitSnapshot(generation: Int, identity: UInt64, forceFull: Bool, callbacks: Int, deliveryStatus: String? = nil) -> Bool {
    let state = lock.withLock { () -> (Document, NormalizedSnapshot?, Int, String)? in
      guard !closed, documentGeneration == generation, documentIdentity == identity,
            let document else { return nil }
      return (document, baseline, documentRevision, status)
    }
    guard let state else { return false }
    // Never wait for the Rust document mutex while holding the session lock.
    let started = ProcessInfo.processInfo.systemUptime
    let full = state.0.snapshotJson()
    let snapshotMs = (ProcessInfo.processInfo.systemUptime - started) * 1_000
    do {
      let normalized = try NormalizedSnapshot(full)
      var patch: String?
      if !forceFull, let previous = state.1 {
        patch = try normalized.patch(from: previous, baseRevision: state.2, revision: state.2 + 1)
        if patch == nil { return true }
      }
      let fullBytes = full.utf8.count
      let patchBytes = patch?.utf8.count
      let usePatch = patchBytes.map { $0 < fullBytes } ?? false
      let delivered = lock.withLock {
        guard !closed, documentGeneration == generation, documentIdentity == identity else { return false }
        documentRevision += 1
        revision += 1
        baseline = normalized
        let update = LiveViewNativeUpdate(sessionId: id, revision: revision,
          documentGeneration: generation, status: store.hasFailure ? "error" : (deliveryStatus ?? state.3), document: usePatch ? nil : full,
          documentKind: usePatch ? "patch" : "full", documentRevision: documentRevision,
          baseDocumentRevision: usePatch ? state.2 : nil, documentPatch: usePatch ? patch : nil,
          patchBytes: usePatch ? patchBytes : nil, fullSnapshotBytes: fullBytes,
          coalescedCallbacks: callbacks, error: store.hasFailure ? "Secure cookie storage failed" : nil,
          snapshotMs: snapshotMs, snapshotBytes: usePatch ? patchBytes : fullBytes,
          callbackCount: callbackCount, clearDocument: false)
        module?.deliver(update, for: self)
        return true
      }
      if delivered && store.hasFailure { close() }
      return delivered
    } catch {
      let current = lock.withLock { () -> Bool in
        guard !closed, documentGeneration == generation, documentIdentity == identity else { return false }
        resetBaseline()
        status = "error"
        module?.deliver(statusUpdate(error: "Document exceeds bridge limits or is invalid", clear: true), for: self)
        return true
      }
      if current { close() }
      return false
    }
  }

  func close() {
    let old = lock.withLock { () -> LiveViewClient? in
      closed = true
      let old = client
      client = nil
      document = nil
      documentIdentity = nil
      resetBaseline()
      return old
    }
    old?.shutdown()
  }
}

// Pure encoder: one bounded normalized baseline, ordered children, canonical
// object comparisons. Node IDs are scoped to the document generation.
private struct NormalizedSnapshot {
  let root: Int
  let nodes: [Int: [String: Any]]
  let canonical: [Int: Data]

  init(_ snapshot: String) throws {
    guard snapshot.utf8.count <= 4 * 1024 * 1024,
          let data = snapshot.data(using: .utf8),
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let root = object["root"] as? Int, root >= 0,
          let list = object["nodes"] as? [[String: Any]], list.count <= 20_000
    else { throw BridgeError.invalidPayload }
    var nodes: [Int: [String: Any]] = [:]
    var canonical: [Int: Data] = [:]
    for node in list {
      guard let id = node["id"] as? Int, id >= 0, nodes[id] == nil else { throw BridgeError.invalidPayload }
      nodes[id] = node
      canonical[id] = try JSONSerialization.data(withJSONObject: node, options: [.sortedKeys, .withoutEscapingSlashes])
    }
    guard nodes[root] != nil else { throw BridgeError.invalidPayload }
    self.root = root; self.nodes = nodes; self.canonical = canonical
  }

  func patch(from previous: NormalizedSnapshot, baseRevision: Int, revision: Int) throws -> String? {
    if root == previous.root, canonical == previous.canonical { return nil }
    let upsert = nodes.keys.sorted().filter { canonical[$0] != previous.canonical[$0] }.compactMap { nodes[$0] }
    let remove = previous.nodes.keys.filter { nodes[$0] == nil }.sorted()
    let object: [String: Any] = ["baseRevision": baseRevision, "revision": revision,
      "root": root, "upsert": upsert, "remove": remove]
    return String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
  }
}

private func nativeJSON(_ value: Any) throws -> Json {
  if value is NSNull { return .null }
  if let number = value as? NSNumber {
    if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(bool: number.boolValue) }
    let encoding = String(cString: number.objCType)
    if ["c", "s", "i", "l", "q"].contains(encoding) {
      let integer = number.int64Value
      return .numb(number: integer < 0 ? .negInt(neg: integer) : .posInt(pos: UInt64(integer)))
    }
    if ["C", "S", "I", "L", "Q"].contains(encoding) {
      return .numb(number: .posInt(pos: number.uint64Value))
    }
    let decimal = number.doubleValue
    guard decimal.isFinite else { throw BridgeError.invalidPayload }
    // Int64.max rounds to 2^63 as a Double, so use a strict upper bound.
    if decimal.rounded(.towardZero) == decimal,
       decimal >= Double(Int64.min), decimal < Double(Int64.max) {
      let integer = Int64(decimal)
      return .numb(number: integer < 0 ? .negInt(neg: integer) : .posInt(pos: UInt64(integer)))
    }
    return .numb(number: .float(float: decimal))
  }
  if let string = value as? String { return .str(string: string) }
  if let array = value as? [Any] { return .array(array: try array.map(nativeJSON)) }
  if let object = value as? [String: Any] { return .object(object: try object.mapValues(nativeJSON)) }
  throw BridgeError.invalidPayload
}

private func jsonReplyString(_ payload: Payload) throws -> String {
  guard case .jsonPayload(let json) = payload, case .object = json else { throw BridgeError.invalidPayload }
  return String(decoding: try JSONSerialization.data(withJSONObject: jsonValue(json)), as: UTF8.self)
}

private func jsonValue(_ json: Json) -> Any {
  switch json {
  case .null: return NSNull()
  case .bool(let value): return value
  case .str(let value): return value
  case .array(let values): return values.map(jsonValue)
  case .object(let values): return values.mapValues(jsonValue)
  case .numb(let number):
    switch number {
    case .posInt(let value): return NSNumber(value: value)
    case .negInt(let value): return NSNumber(value: value)
    case .float(let value): return NSNumber(value: value)
    }
  }
}
