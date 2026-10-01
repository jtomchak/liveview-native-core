import test from 'node:test';
import assert from 'node:assert/strict';
import { UploadController, validateUploadAsset, type PickedUploadAsset } from '../src/uploadController';
const asset: PickedUploadAsset = { uri: 'file:///cache/note.txt', name: 'note.txt', mimeType: 'text/plain', size: 10 };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('selection validates type, local URI and size before native transfer', () => {
  assert.doesNotThrow(() => validateUploadAsset(asset));
  assert.doesNotThrow(() => validateUploadAsset({ ...asset, size: 2 * 1024 * 1024 }));
  for (const invalid of [{ ...asset, size: 2 * 1024 * 1024 + 1 }, { ...asset, size: 0 }, { ...asset, mimeType: 'application/pdf' }, { ...asset, name: 'file.pdf' }, { ...asset, uri: 'https://server/note.txt' }]) assert.throws(() => validateUploadAsset(invalid));
});
test('picker cancellation transfers nothing and double taps open only one picker', async () => {
  const picked = deferred<PickedUploadAsset | null>(); let picks = 0; let transfers = 0;
  const controller = new UploadController(async () => { picks++; return picked.promise; }, async () => { transfers++; });
  const pending = controller.select(true); await controller.select(true); assert.equal(picks, 1);
  picked.resolve(null); await pending; assert.equal(transfers, 0); assert.equal(controller.getSnapshot().phase, 'idle'); assert.equal(controller.getSnapshot().busy, false); controller.dispose();
});
test('native completion cannot invent progress, ready status or durable save', async () => {
  const controller = new UploadController(async () => asset, async () => {});
  await controller.select(true); assert.equal(controller.getSnapshot().phase, 'awaiting'); assert.equal(controller.getSnapshot().progress, null);
  controller.updateServer('uploading', 'entry-1', 75); assert.equal(controller.getSnapshot().progress, 75); assert.equal(controller.getSnapshot().phase, 'uploading');
  controller.updateServer('ready', 'entry-1', 100); assert.equal(controller.getSnapshot().phase, 'ready');
  controller.updateServer('saved', null, 100); assert.equal(controller.getSnapshot().phase, 'saved'); controller.dispose();
});
test('server cancellation invalidates an outstanding transfer completion', async () => {
  const transferred = deferred<void>(); const controller = new UploadController(async () => asset, () => transferred.promise);
  const pending = controller.select(true); await Promise.resolve(); controller.updateServer('uploading', 'entry-1', 20); controller.updateServer('idle', null, 0);
  assert.equal(controller.getSnapshot().phase, 'cancelled'); assert.equal(controller.getSnapshot().busy, false);
  transferred.resolve(); await pending; assert.equal(controller.getSnapshot().phase, 'cancelled'); controller.dispose();
});
test('an active failed entry must be cancelled before another selection', async () => {
  let picks = 0; const controller = new UploadController(async () => { picks++; return asset; }, async () => { throw new Error('Lost connection'); });
  controller.updateServer('uploading', 'entry-1', 20); controller.updateServer('error', 'entry-1', 20, ['Rejected upload']);
  await controller.select(true); assert.equal(picks, 0); assert.equal(controller.getSnapshot().error, 'Rejected upload');
  controller.updateServer('cancelled', null, 0); await controller.select(true); assert.equal(picks, 1); assert.equal(controller.getSnapshot().phase, 'error'); controller.dispose();
});
test('stale picker and transfer settlements cannot touch a replacement document', async () => {
  const picked = deferred<PickedUploadAsset | null>(); let transfers = 0;
  const picker = new UploadController(() => picked.promise, async () => { transfers++; }); const selecting = picker.select(true); picker.dispose(); picked.resolve(asset); await selecting; assert.equal(transfers, 0);
  const transferred = deferred<void>(); const upload = new UploadController(async () => asset, () => transferred.promise); const pending = upload.select(true); await Promise.resolve(); upload.dispose(); transferred.reject(new Error('Old upload failed')); await pending;
  assert.equal(upload.getSnapshot().error, null);
});
test('repeated saved metadata cannot cancel a new picker; invalid progress stays unknown', async () => {
  const picked = deferred<PickedUploadAsset | null>(); const controller = new UploadController(() => picked.promise, async () => {});
  controller.updateServer('saved', null, 100); const pending = controller.select(true); controller.updateServer('saved', null, 100);
  assert.equal(controller.getSnapshot().phase, 'picking'); picked.resolve(asset); await pending;
  controller.updateServer('uploading', 'entry-2', 101); assert.equal(controller.getSnapshot().progress, null); assert.notEqual(controller.getSnapshot().phase, 'saved'); controller.dispose();
});
test('StrictMode effect replay preserves a usable controller and old selection guards', async () => {
  let transfers = 0; const controller = new UploadController(async () => asset, async () => { transfers++; });
  controller.dispose(); controller.activate(); await controller.select(true); assert.equal(transfers, 1); assert.equal(controller.getSnapshot().phase, 'awaiting'); controller.dispose();
});
test('missing picker is explicit and disconnected controls cannot start an upload', async () => {
  let transfers = 0; const controller = new UploadController(undefined, async () => { transfers++; });
  await controller.select(false); assert.equal(controller.getSnapshot().phase, 'idle'); await controller.select(true); assert.match(controller.getSnapshot().error!, /picker must be installed/); assert.equal(transfers, 0); controller.dispose();
});

test('late progress for a cancelled entry cannot resurrect it, while a new entry is accepted', () => {
  const controller = new UploadController(async () => asset, async () => {});
  controller.updateServer('uploading', 'entry-1', 20); controller.updateServer('cancelled', null, 0);
  controller.updateServer('uploading', 'entry-1', 80);
  assert.equal(controller.getSnapshot().phase, 'cancelled'); assert.equal(controller.getSnapshot().progress, null); assert.equal(controller.getSnapshot().entryRef, null);
  controller.updateServer('ready', 'entry-1', 100); assert.equal(controller.getSnapshot().phase, 'cancelled');
  controller.updateServer('uploading', 'entry-2', 10); assert.equal(controller.getSnapshot().phase, 'uploading'); assert.equal(controller.getSnapshot().entryRef, 'entry-2'); assert.equal(controller.getSnapshot().progress, 10); controller.dispose();
});
