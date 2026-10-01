import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveViewStore } from '../src/store';
import { setTelemetrySink } from '../src/telemetry';
import type { LiveViewTransport, NativeUpdate } from '../src/types';

function harness() {
  const listeners = new Set<(update: NativeUpdate) => void>();
  const connects: string[] = [];
  const disconnects: string[] = [];
  const sent: unknown[][] = [];
  const transport: LiveViewTransport = {
    async connect(id) { connects.push(id); },
    async postForm() {}, async logout() {},
    async navigate() {}, async back() {}, async forward() {}, async getNavigation() { return JSON.stringify({url:null,canGoBack:false,canGoForward:false}); },
    async disconnect(id) { disconnects.push(id); },
    async sendForm() { return JSON.stringify({reply:{status:"valid",client_seq:1}}); },
    async sendEvent(...args) { sent.push(args); },
    addListener(_, listener) {
      listeners.add(listener);
      return { remove() { listeners.delete(listener); } };
    },
  };
  const store = new LiveViewStore(transport, 'http://localhost:4001/react_native');
  const emit = (id: string, revision: number, document: string | null = null, status = 'connected') => {
    listeners.forEach(listener => listener({ sessionId: id, revision, document, status, error: null }));
  };
  return { transport, store, emit, connects, disconnects, sent, listeners };
}

const document = (value: string) => JSON.stringify({ root: 0, nodes: [
  { id: 0, kind: 'root', children: [1] },
  { id: 1, kind: 'text', text: value, children: [] },
] });

test('React reads a stable snapshot; stale revisions and other sessions do not render', () => {
  const h = harness();
  h.store.start();
  const id = h.connects[0];
  assert.equal(h.store.getSnapshot(), h.store.getSnapshot());
  h.emit(id, 2, document('2'));
  const snapshot = h.store.getSnapshot();
  h.emit(id, 1, document('1'));
  h.emit('another-session', 99, document('99'));
  assert.equal(h.store.getSnapshot(), snapshot);
  h.emit(id, 3, null, 'disconnected');
  assert.equal(h.store.getSnapshot().document, snapshot.document);
  assert.equal(h.store.getSnapshot().status, 'disconnected');
  h.store.stop();
});

test('StrictMode setup/cleanup/setup uses a new ID and removes every listener', async () => {
  const h = harness();
  h.store.start();
  const old = h.connects[0];
  h.store.stop();
  h.store.start();
  const current = h.connects[1];
  assert.notEqual(current, old);
  assert.equal(h.store.getSnapshot().sessionId, current);
  assert.equal(h.store.getSnapshot().revision, -1);
  assert.deepEqual(h.disconnects, [old]);
  assert.equal(h.listeners.size, 1);
  h.emit(old, 100, document('old'));
  assert.equal(h.store.getSnapshot().document, null);
  h.emit(current, 0, document('new'));
  await h.store.pushEvent('increment', { step: '2' });
  assert.deepEqual(h.sent[0], [current, 'increment', '{"step":"2"}']);
  h.store.stop();
  assert.equal(h.listeners.size, 0);
  await assert.rejects(h.store.pushEvent('increment'), /not mounted/);
});

test('retained document cannot send events after its network disconnects', async () => {
  const h = harness();
  h.store.start();
  const id = h.connects[0];
  h.emit(id, 0, document('retained'));
  h.emit(id, 1, null, 'disconnected');
  await assert.rejects(h.store.pushEvent('increment'), /not connected/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.store.getSnapshot().document?.nodes.get(1)?.text, 'retained');
  h.store.retry();
  assert.notEqual(h.store.getSnapshot().sessionId, id);
  assert.equal(h.store.getSnapshot().document?.nodes.get(1)?.text, 'retained');
  h.store.stop();
});

test('invalid updates preserve the last good tree and later valid updates recover', () => {
  const h = harness();
  h.store.start();
  const id = h.connects[0];
  h.emit(id, 0, document('good'));
  const good = h.store.getSnapshot().document;
  h.emit(id, 1, '{bad JSON');
  assert.equal(h.store.getSnapshot().document, good);
  assert.equal(h.store.getSnapshot().status, 'error');
  h.emit(id, 2, document('recovered'));
  assert.equal(h.store.getSnapshot().error, null);
  assert.equal(h.store.getSnapshot().document?.nodes.get(1)?.text, 'recovered');
  h.store.stop();
});

test('old connect failures cannot overwrite a new session', async () => {
  const h = harness();
  let rejectOld!: (reason: Error) => void;
  let first = true;
  h.transport.connect = (id) => {
    h.connects.push(id);
    if (first) { first = false; return new Promise((_, reject) => { rejectOld = reject; }); }
    return Promise.resolve();
  };
  h.store.start();
  h.store.retry();
  h.emit(h.connects[1], 0, document('new'));
  const snapshot = h.store.getSnapshot();
  rejectOld(new Error('old failed'));
  await Promise.resolve();
  assert.equal(h.store.getSnapshot(), snapshot);
  h.store.stop();
});

test('native subscription setup errors become observable connection errors', () => {
  const h = harness();
  h.transport.addListener = () => { throw new Error('native event binding missing'); };
  assert.doesNotThrow(h.store.start);
  assert.equal(h.store.getSnapshot().status, 'error');
  assert.equal(h.store.getSnapshot().error, 'native event binding missing');
  h.store.stop();
});


test('document generation rejects late callbacks and requires coherent replacement', () => {
  const h = harness(); h.store.start(); const id = h.connects[0];
  const send = (generation: number, revision: number, value: string | null) => h.listeners.forEach(listener => listener({sessionId:id, documentGeneration:generation, revision, document:value, status:'connected', error:null}));
  send(1, 1, document('first')); send(2, 2, document('replacement'));
  const snapshot = h.store.getSnapshot();
  send(1, 99, document('old')); assert.equal(h.store.getSnapshot(), snapshot);
  send(3, 3, null); assert.equal(h.store.getSnapshot().status, 'error');
  send(3, 4, document('coherent')); assert.equal(h.store.getSnapshot().documentGeneration, 3);
  assert.equal(h.store.getSnapshot().document?.nodes.get(1)?.text, 'coherent');
  h.store.stop();
});


test('authentication rejects foreign origins and clears document immediately on logout', async () => {
  const h=harness();h.store.start();const id=h.connects[0];h.emit(id,1,document('private'));
  await assert.rejects(h.store.postForm('https://foreign.test/session',{password:'secret'}), /origin/);
  await assert.rejects(h.store.postForm('http://user:secret@localhost:4001/session',{}), /origin/);
  let resolve!:()=>void; h.transport.logout=()=>new Promise(r=>{resolve=r;});
  const pending=h.store.logout('/session/delete');
  assert.equal(h.store.getSnapshot().document,null);
  assert.equal(h.store.getSnapshot().status,'signing-out');resolve();await pending;
  assert.notEqual(h.store.getSnapshot().sessionId,id);assert.equal(h.store.getSnapshot().document,null);
  h.emit(id,999,document('stale private'));assert.equal(h.store.getSnapshot().document,null);h.store.stop();
});


test('native origin logout invalidation clears a retained protected document', () => {
  const h=harness();h.store.start();const id=h.connects[0];h.emit(id,1,document('private'));
  h.listeners.forEach(listener=>listener({sessionId:id,revision:2,documentGeneration:0,status:'disconnected',document:null,error:null,clearDocument:true}));
  assert.equal(h.store.getSnapshot().document,null);assert.equal(h.store.getSnapshot().status,'disconnected');h.store.stop();
});

test('resolved authentication form is not a successful-login measurement', async () => {
  const h = harness(); const names: string[] = [];
  setTelemetrySink(event => names.push(event.name));
  try {
    h.store.start(); h.emit(h.connects[0], 1, document('Sign in'));
    await h.store.postForm('/session', {account: 'workshop', password: 'wrong'});
    assert.ok(names.includes('lvn.auth.form_post'));
    assert.ok(!names.includes('lvn.auth.login'));
  } finally { h.store.stop(); setTelemetrySink(); }
});

test('failed remote logout still clears local state and cannot claim confirmed logout', async () => {
  const h=harness(); const names:string[]=[];setTelemetrySink(event=>names.push(event.name));
  try {
    h.store.start(); const id=h.connects[0]; h.emit(id,1,document('private'));
    h.transport.logout=async()=>{throw new Error('offline');};
    await assert.rejects(h.store.logout('/session/delete'), /offline/);
    assert.equal(h.store.getSnapshot().document,null);
    assert.notEqual(h.store.getSnapshot().sessionId,id);
    assert.ok(names.includes('lvn.auth.local_logout')); assert.ok(!names.includes('lvn.auth.logout'));
    assert.match(h.store.getSnapshot().error!, /revocation was not confirmed/);
  } finally {h.store.stop();setTelemetrySink();}
});

test('navigation is origin-scoped and only enqueued until a coherent document arrives', async () => {
  const h=harness();h.store.start();const id=h.connects[0];h.emit(id,1,document('list'));
  const requests:unknown[][]=[];h.transport.navigate=async(...args)=>{requests.push(args);};
  await assert.rejects(h.store.navigate('https://foreign.test/detail'),/origin/);
  await h.store.navigate('/checklists/workshop', true);
  assert.deepEqual(requests,[[id,'http://localhost:4001/checklists/workshop',true]]);
  assert.equal(h.store.getSnapshot().document?.nodes.get(1)?.text,'list');
  h.transport.getNavigation=async()=>JSON.stringify({url:'http://localhost:4001/checklists/workshop',canGoBack:true,canGoForward:false});
  assert.equal((await h.store.getNavigation()).canGoBack,true);
  h.transport.getNavigation=async()=>JSON.stringify({url:'https://foreign.test/',canGoBack:true,canGoForward:false});
  await assert.rejects(h.store.getNavigation(), /origin/);h.store.stop();
});

test('form transport preserves nested field encoding and correlates business replies', async () => {
  const h=harness();h.store.start();const id=h.connects[0];h.emit(id,1,document('form'));
  let sent:unknown[]=[];
  h.transport.sendForm=async(...args)=>{sent=args;return JSON.stringify({diff:{r:{status:'saved',client_seq:7,version:2}}});};
  const reply=await h.store.sendForm('save_task',{'task[title]':'A + B & café','client_seq':'7'},'task[title]');
  assert.deepEqual(reply,{status:'saved',clientSeq:7,version:2});assert.equal(sent[0],id);assert.equal(sent[3],null);
  const params=new URLSearchParams(String(sent[2]));assert.equal(params.get('task[title]'),'A + B & café');assert.equal(params.get('_target'),'task[title]');
  h.transport.sendForm=async()=>JSON.stringify({diff:{}});assert.equal((await h.store.sendForm('save_task',{})).status,'unknown');
  await assert.rejects(h.store.sendForm('save_task',{},undefined,0),/Invalid form/);h.store.stop();
});

test('late form errors cannot overwrite a replacement generation', async () => {
  const h=harness();h.store.start();const id=h.connects[0];h.emit(id,1,document('form'));
  let reject!:(e:Error)=>void;h.transport.sendForm=()=>new Promise((_,r)=>{reject=r;});
  const pending=h.store.sendForm('save_task',{});
  h.listeners.forEach(listener=>listener({sessionId:id,revision:2,documentGeneration:1,status:'connected',document:document('detail'),error:null}));
  const snapshot=h.store.getSnapshot();reject(new Error('old form failed'));await assert.rejects(pending,/old form/);
  assert.equal(h.store.getSnapshot(),snapshot);h.store.stop();
});
