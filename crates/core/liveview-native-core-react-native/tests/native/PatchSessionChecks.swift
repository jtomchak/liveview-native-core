// Minimal platform collaborators; NativeSession and its encoder are extracted
// unchanged from the production Swift module, including the real serial queue.
private enum BridgeError: Error { case disconnected, invalidPayload }
private enum NavEventType { case push, replace, traverse, patch, reload }
private final class NativeCookieStore: @unchecked Sendable { var hasFailure = false }
private final class LiveViewClient { func shutdown() {} }
private final class DocumentCallbacks { init(_ session: NativeSession, generation: Int) {} }
private final class Document: @unchecked Sendable {
  let value: UInt64
  let gate: DispatchSemaphore?
  let started: DispatchSemaphore?
  var snapshots = 0
  init(_ value: UInt64, gate: DispatchSemaphore? = nil, started: DispatchSemaphore? = nil) {
    self.value = value; self.gate = gate; self.started = started
  }
  func identity() -> UInt64 { value }
  func setEventHandler(_ callback: DocumentCallbacks) {}
  func snapshotJson() -> String {
    snapshots += 1
    if snapshots == 1 { started?.signal(); gate?.wait() }
    return #"{"root":0,"nodes":[{"id":0,"kind":"root","children":[]}]}"#
  }
}
private final class LiveViewNativeModule: @unchecked Sendable {
  let lock = NSLock()
  var events: [LiveViewNativeUpdate] = []
  let event = DispatchSemaphore(value: 0)
  func deliver(_ update: LiveViewNativeUpdate, for session: NativeSession) {
    lock.withLock { events.append(update) }
    event.signal()
  }
  func wait(_ count: Int) { for _ in 0..<count { precondition(event.wait(timeout: .now() + 3) == .success) } }
}


private func runChecks() {
  let module = LiveViewNativeModule()
  let store = NativeCookieStore()
  let session = NativeSession(id: "test", origin: "http://localhost:4001", store: store, module: module)
  let gate = DispatchSemaphore(value: 0), started = DispatchSemaphore(value: 0)
  let first = Document(1, gate: gate, started: started)
  session.publish(status: "connected", document: first)
  precondition(started.wait(timeout: .now() + 3) == .success)
  session.publish(status: "reconnecting")
  session.publish(status: "error", error: "test")
  gate.signal()
  module.wait(3)
  precondition(module.events.map { $0.documentKind } == ["full", "status", "status"])
  precondition(module.events.map { $0.revision } == [1, 2, 3])
  precondition(module.events.map { $0.status } == ["connected", "reconnecting", "error"])
  precondition(module.events.map { $0.documentRevision } == [1, 1, 1])
  precondition(module.events[1].document == nil && module.events[1].snapshotBytes == nil && first.snapshots == 1)
  let requested = DispatchSemaphore(value: 0)
  Task { try! await session.requestSnapshot(); requested.signal() }
  precondition(requested.wait(timeout: .now() + 3) == .success)
  module.wait(1)
  precondition(module.events.last!.documentKind == "full" && module.events.last!.documentRevision == 2)
  session.publish(documentChanged: true, expectedGeneration: 1)
  session.publish(status: "connected", document: Document(2))
  module.wait(1)
  Thread.sleep(forTimeInterval: 0.03)
  session.publish(documentChanged: true, expectedGeneration: 1)
  precondition(module.events.count == 5 && module.events.last!.documentGeneration == 2 && module.events.last!.documentRevision == 3)
  let clear = session.invalidationUpdate()
  precondition(clear.clearDocument && clear.documentKind == "status" && clear.documentRevision == 3)
  session.close()
  let failedModule = LiveViewNativeModule(), failedStore = NativeCookieStore()
  let failed = NativeSession(id: "failure", origin: "http://localhost:4001", store: failedStore, module: failedModule)
  failedStore.hasFailure = true
  failed.publish(status: "error", error: "safe")
  failedModule.wait(1)
  precondition(failedModule.events.first!.error == "Secure cookie storage failed")
  print("Actual Swift NativeSession passed full-before-status ordering, monotonic revisions, status-no-snapshot, forced resync, stale generation timer/callback cancellation, clear, and secure error-before-close")
}
runChecks()
