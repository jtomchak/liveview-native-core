import ExpoModulesCore
import Foundation
import CoreFoundation

@Record
fileprivate struct LiveViewNativeUpdate {
  var sessionId: String
  var revision: Int
  var documentGeneration: Int
  var status: String
  var document: String?
  var error: String?
  var snapshotMs: Double?
  var snapshotBytes: Int?
  var callbackCount: Int
}

@ExpoModule("LiveViewNative")
public final class LiveViewNativeModule: Module {
  private let lock = NSLock()
  private var sessions: [String: NativeSession] = [:]

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
    let session = NativeSession(id: id, module: self)
    let old = self.lock.withLock { self.sessions.updateValue(session, forKey: id) }
    old?.close()
    session.publish(status: "connecting")
    let builder = LiveViewClientBuilder()
    builder.setFormat(.reactNative)
    let callbacks = SessionCallbacks(session)
    builder.setLiveChannelEventHandler(callbacks)
    do {
      let client = try await builder.connect(url, ClientConnectOpts())
      session.install(client)
    } catch {
      session.publish(status: "error", error: String(describing: error))
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
    } catch {
      session.publish(status: "error", error: String(describing: error))
      throw error
    }
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
  case invalidURL, invalidPayload, disconnected
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

  init(id: String, module: LiveViewNativeModule) { self.id = id; self.module = module }

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
    let update = lock.withLock { () -> LiveViewNativeUpdate? in
      guard !closed else { return nil }
      if let expectedGeneration, expectedGeneration != documentGeneration { return nil }
      if let status { self.status = status }
      if let document {
        let identity = document.identity()
        if documentIdentity != identity {
          documentGeneration += 1
          documentIdentity = identity
        }
        self.document = document
        document.setEventHandler(DocumentCallbacks(self, generation: documentGeneration))
      }
      if documentChanged { callbackCount += 1 }
      // Uptime is monotonic; wall-clock changes must not affect durations.
      let started = ProcessInfo.processInfo.systemUptime
      let snapshot = self.document?.snapshotJson()
      let snapshotMs = snapshot == nil ? nil : (ProcessInfo.processInfo.systemUptime - started) * 1_000
      revision += 1
      return LiveViewNativeUpdate(sessionId: id, revision: revision,
                                  documentGeneration: documentGeneration, status: self.status,
                                  document: snapshot, error: error, snapshotMs: snapshotMs,
                                  snapshotBytes: snapshot?.utf8.count, callbackCount: callbackCount)
    }
    if let update { module?.deliver(update, for: self) }
  }

  func close() {
    let old = lock.withLock { () -> LiveViewClient? in
      closed = true
      let old = client
      client = nil
      document = nil
      documentIdentity = nil
      return old
    }
    old?.shutdown()
  }
}

private func nativeJSON(_ value: Any) throws -> Json {
  if value is NSNull { return .null }
  if let number = value as? NSNumber {
    if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(bool: number.boolValue) }
    return .numb(number: .float(float: number.doubleValue))
  }
  if let string = value as? String { return .str(string: string) }
  if let array = value as? [Any] { return .array(array: try array.map(nativeJSON)) }
  if let object = value as? [String: Any] { return .object(object: try object.mapValues(nativeJSON)) }
  throw BridgeError.invalidPayload
}
