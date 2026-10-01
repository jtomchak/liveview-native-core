import test from 'node:test';
import assert from 'node:assert/strict';
import { FormController, MemoryFormDraftStore, serializeForm, type FormResponse } from '../src/formEvents';

const initial = { 'task[id]': 'task-1', 'task[version]': '1', 'task[title]': 'Original', 'task[notes]': '', 'task[completed]': 'false' };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve!: (reply: FormResponse) => void; let reject!: (error: Error) => void; const promise = new Promise<FormResponse>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('whole-form serialization preserves nested names, booleans, Unicode and changed field', () => {
  const encoded = serializeForm({ ...initial, 'task[title]': 'Make café + tools', client_seq: '2' }, 'task[title]');
  const params = new URLSearchParams(encoded);
  assert.equal(params.get('task[title]'), 'Make café + tools');
  assert.equal(params.get('task[completed]'), 'false');
  assert.equal(params.get('task[version]'), '1');
  assert.equal(params.get('_target'), 'task[title]');
  assert.equal(params.get('client_seq'), '2');
});
test('debounced validation sends the complete latest form once', async () => {
  const calls: { event: string; fields: Readonly<Record<string, string>>; changed?: string }[] = [];
  const controller = new FormController('workshop:task-1', initial, new MemoryFormDraftStore(), async (event, fields, changed) => { calls.push({ event, fields, changed }); return { status: 'valid' }; }, 'validate', 'save', 15);
  controller.setField('task[title]', 'Changed'); controller.setField('task[notes]', 'My draft'); controller.setField('task[completed]', 'true');
  await delay(30);
  assert.equal(calls.length, 1); assert.equal(calls[0].event, 'validate'); assert.equal(calls[0].changed, 'task[completed]');
  assert.equal(calls[0].fields['task[title]'], 'Changed'); assert.equal(calls[0].fields['task[notes]'], 'My draft'); assert.equal(calls[0].fields['task[completed]'], 'true'); assert.equal(calls[0].fields.client_seq, '3');
  controller.dispose();
});
test('dirty values and expected version survive server patches and stale validation', () => {
  const controller = new FormController('workshop:task-1', initial, new MemoryFormDraftStore(), async () => ({ status: 'valid' }), null, 'save');
  controller.setField('task[title]', 'Typing a draft');
  controller.updateServer({ ...initial, 'task[title]': 'Remote', 'task[version]': '2' }, 0, { title: 'Old validation' });
  assert.equal(controller.getSnapshot().fields['task[title]'], 'Typing a draft'); assert.equal(controller.getSnapshot().fields['task[version]'], '1'); assert.deepEqual(controller.getSnapshot().errors, {});
  controller.updateServer(initial, 1, { title: 'Current validation' }); assert.equal(controller.getSnapshot().errors.title, 'Current validation'); controller.dispose();
});
test('an older validation rejection cannot overwrite newer input', async () => {
  const first = deferred(); let calls = 0;
  const controller = new FormController('workshop:task-1', initial, new MemoryFormDraftStore(), async () => ++calls === 1 ? first.promise : { status: 'valid' }, 'validate', 'save', 1);
  controller.setField('task[title]', 'First'); await delay(10); controller.setField('task[title]', 'Second');
  first.reject(new Error('Old network error')); await delay(10);
  assert.equal(controller.getSnapshot().fields['task[title]'], 'Second'); assert.equal(controller.getSnapshot().error, null); controller.dispose();
});
test('submit cancels pending debounce and prevents duplicate saves until acknowledgement', async () => {
  const reply = deferred(); const calls: string[] = []; const store = new MemoryFormDraftStore();
  const controller = new FormController('workshop:task-1', initial, store, async event => { calls.push(event); return reply.promise; }, 'validate', 'save', 20);
  controller.setField('task[title]', 'Saved title'); const first = controller.submit(true); await controller.submit(true); await delay(30);
  assert.deepEqual(calls, ['save']); assert.equal(controller.getSnapshot().submitting, true);
  reply.resolve({ status: 'saved', clientSeq: 2, version: 2 }); await first;
  assert.equal(store.get('workshop:task-1'), undefined); assert.equal(controller.getSnapshot().dirty, false); assert.equal(controller.getSnapshot().fields['task[version]'], '2'); controller.dispose();
});
test('conflicts and mismatched acknowledgements preserve the exact draft baseline', async () => {
  const store = new MemoryFormDraftStore();
  const controller = new FormController('workshop:task-1', initial, store, async () => ({ status: 'conflict', clientSeq: 2 }), null, 'save');
  controller.setField('task[title]', 'Keep this draft'); await controller.submit(true);
  controller.updateServer({ ...initial, 'task[version]': '5' }, 2, {}, 'conflict');
  assert.equal(store.get('workshop:task-1')?.fields['task[version]'], '1'); assert.equal(controller.getSnapshot().fields['task[title]'], 'Keep this draft'); assert.match(controller.getSnapshot().error!, /draft has been kept/);
  controller.dispose();
  const wrongAck = new FormController('workshop:task-1', initial, store, async () => ({ status: 'saved', clientSeq: 999, version: 9 }), null, 'save');
  await wrongAck.submit(true); assert.ok(store.get('workshop:task-1')); assert.equal(wrongAck.getSnapshot().fields['task[version]'], '1'); wrongAck.dispose();
});
test('acknowledged save clears its draft after navigation unmount but cannot erase newer edits', async () => {
  const store = new MemoryFormDraftStore(); const reply = deferred();
  const controller = new FormController('workshop:task-1', initial, store, async () => reply.promise, null, 'save');
  controller.setField('task[title]', 'Saved'); const pending = controller.submit(true); controller.dispose(); reply.resolve({ status: 'saved', clientSeq: 2, version: 2 }); await pending;
  assert.equal(store.get('workshop:task-1'), undefined);
  const secondReply = deferred(); const older = new FormController('workshop:task-1', initial, store, async () => secondReply.promise, null, 'save');
  older.setField('task[title]', 'Older'); const secondPending = older.submit(true); older.dispose();
  const newer = new FormController('workshop:task-1', initial, store, async () => ({ status: 'valid' }), null, 'save'); newer.setField('task[title]', 'Newer');
  secondReply.resolve({ status: 'saved', clientSeq: 2, version: 2 }); await secondPending;
  assert.equal(store.get('workshop:task-1')?.fields['task[title]'], 'Newer'); newer.dispose();
});
test('document teardown cancels debounced events; replaying effects leaves controls usable', async () => {
  let sends = 0; const store = new MemoryFormDraftStore();
  const controller = new FormController('workshop:task-1', initial, store, async () => { sends++; return { status: 'valid' }; }, 'validate', 'save', 10);
  controller.setField('task[title]', 'Old document'); controller.dispose(); await delay(20); assert.equal(sends, 0);
  controller.activate(); controller.setField('task[title]', 'Active document'); await delay(20); assert.equal(sends, 1); controller.cancel(); assert.equal(store.get('workshop:task-1'), undefined); controller.dispose();
});
test('draft storage is bounded and account clearing does not mix accounts', () => {
  const store = new MemoryFormDraftStore(2);
  store.set('workshop:a', { fields: initial, sequence: 1 }); store.set('studio:a', { fields: initial, sequence: 1 }); store.set('workshop:b', { fields: initial, sequence: 1 });
  assert.equal(store.get('workshop:a'), undefined); store.clearAccount('workshop'); assert.equal(store.get('workshop:b'), undefined); assert.ok(store.get('studio:a')); store.clear(); assert.equal(store.get('studio:a'), undefined);
  assert.throws(() => new MemoryFormDraftStore(0));
});

test('only a current acknowledged save can trigger navigation; failures leave a confirmed saved form', async () => {
  const store = new MemoryFormDraftStore(); const first = deferred(); let navigations = 0;
  const old = new FormController('workshop:task-1', initial, store, async () => first.promise, null, 'save', 250, undefined, async () => { navigations++; });
  old.setField('task[title]', 'Saved before unmount'); const pending = old.submit(true); old.dispose();
  first.resolve({ status: 'saved', clientSeq: 2, version: 2 }); await pending;
  assert.equal(navigations, 0); assert.equal(store.get('workshop:task-1'), undefined);
  const current = new FormController('workshop:task-1', initial, store, async () => ({ status: 'saved', clientSeq: 2, version: 2 }), null, 'save', 250, undefined, async () => { navigations++; throw new Error('Disconnected'); });
  current.setField('task[title]', 'Confirmed save'); await current.submit(true);
  assert.equal(navigations, 1); assert.equal(current.getSnapshot().dirty, false); assert.equal(current.getSnapshot().submitting, false); assert.equal(store.get('workshop:task-1'), undefined); assert.match(current.getSnapshot().error!, /Task saved, but navigation failed/); current.dispose();
});
test('unauthorized replies navigate only when their sequence matches the current form', async () => {
  let navigations = 0; const store = new MemoryFormDraftStore();
  const old = new FormController('workshop:task-1', initial, store, async () => ({ status: 'unauthorized', clientSeq: 99 }), null, 'save', 250, undefined, undefined, async () => { navigations++; });
  await old.submit(true); assert.equal(navigations, 0); old.dispose(); store.clear();
  const current = new FormController('workshop:task-1', initial, store, async () => ({ status: 'unauthorized', clientSeq: 1 }), null, 'save', 250, undefined, undefined, async () => { navigations++; });
  await current.submit(true); assert.equal(navigations, 1); current.dispose();
});

test('failed local persistence cannot claim a saved edit or dispatch a submission', async () => {
  class FailingStore extends MemoryFormDraftStore { fail = false; override set(key: string, draft: any) { if(this.fail) throw new Error('disk full'); super.set(key,draft); } override delete(key:string) { if(this.fail) throw new Error('disk full'); super.delete(key); } }
  const drafts=new FailingStore(); let sends=0;
  const controller=new FormController('workshop:task-1', initial, drafts, async()=>{sends++; return {status:'saved',clientSeq:2};},null,'save');
  drafts.fail=true; controller.setField('task[title]','Unpersisted'); assert.equal(controller.getSnapshot().fields['task[title]'],initial['task[title]']); assert.equal(controller.getSnapshot().dirty,false); assert.match(controller.getSnapshot().error!,/could not be saved/);
  drafts.fail=false; controller.setField('task[title]','Persisted'); drafts.fail=true; await controller.submit(true); assert.equal(sends,0); assert.equal(controller.getSnapshot().submitting,false); assert.equal(controller.cancel(),false); assert.match(controller.getSnapshot().error!,/could not be discarded/); controller.dispose();
});
