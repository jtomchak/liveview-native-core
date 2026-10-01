// The runner injects the actual private NormalizedSnapshot from the module.
private enum BridgeError: Error { case invalidPayload }
private func runEncoderChecks() throws {
let base = try NormalizedSnapshot(#"{"root":0,"nodes":[{"id":0,"kind":"root","children":[1]},{"id":1,"kind":"element","tag":"View","attributes":{"a":"1","b":"2"},"children":[2]},{"id":2,"kind":"text","text":"old","children":[]}]}"#)
let reordered = try NormalizedSnapshot(#"{"nodes":[{"text":"old","id":2,"children":[],"kind":"text"},{"children":[2],"tag":"View","attributes":{"b":"2","a":"1"},"kind":"element","id":1},{"children":[1],"id":0,"kind":"root"}],"root":0}"#)
let noPatch = try reordered.patch(from: base, baseRevision: 7, revision: 8)
precondition(noPatch == nil)
let changed = try NormalizedSnapshot(#"{"root":0,"nodes":[{"id":0,"kind":"root","children":[1]},{"id":1,"kind":"element","tag":"View","attributes":{"a":"1","b":"2"},"children":[3]},{"id":3,"kind":"text","text":"new","children":[]}]}"#)
let wire = try changed.patch(from: base, baseRevision: 7, revision: 8)!
let patch = try JSONSerialization.jsonObject(with: Data(wire.utf8)) as! [String: Any]
precondition(patch["baseRevision"] as! Int == 7 && patch["revision"] as! Int == 8)
precondition(patch["remove"] as! [Int] == [2])
precondition((patch["upsert"] as! [[String: Any]]).map { $0["id"] as! Int } == [1, 3])
let orderA = try NormalizedSnapshot(#"{"root":0,"nodes":[{"id":0,"kind":"root","children":[1,2]},{"id":1,"kind":"text","text":"a","children":[]},{"id":2,"kind":"text","text":"b","children":[]}]}"#)
let orderB = try NormalizedSnapshot(#"{"root":0,"nodes":[{"id":0,"kind":"root","children":[2,1]},{"id":1,"kind":"text","text":"a","children":[]},{"id":2,"kind":"text","text":"b","children":[]}]}"#)
let orderPatch = try orderB.patch(from: orderA, baseRevision: 8, revision: 9)!
let orderValue = try JSONSerialization.jsonObject(with: Data(orderPatch.utf8)) as! [String: Any]
precondition((orderValue["upsert"] as! [[String: Any]]).first!["children"] as! [Int] == [2,1])
let tooMany = "{\"root\":0,\"nodes\":[" + Array(repeating: "{\"id\":0}", count: 20_001).joined(separator: ",") + "]}"
do { _ = try NormalizedSnapshot(tooMany); fatalError("Node bound not enforced") } catch {}
do { _ = try NormalizedSnapshot(String(repeating: " ", count: 4 * 1024 * 1024 + 1)); fatalError("Byte bound not enforced") } catch {}
print("Swift native encoder passed canonical order, unchanged, removal/upsert, child order, revision, and byte/node bounds")

}
try runEncoderChecks()
