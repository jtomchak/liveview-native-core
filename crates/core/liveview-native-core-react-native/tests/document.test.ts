import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocument } from '../src/document';
import { clickEvent } from '../src/events';

const valid = {
  root: 0,
  nodes: [
    { id: 0, kind: 'root', children: [1] },
    { id: 1, kind: 'element', tag: 'Text', attributes: { id: 'counter' }, children: [2] },
    { id: 2, kind: 'text', text: '42', children: [] },
  ],
};

test('valid atomic tree is parsed into frozen nodes and child lists', () => {
  const tree = parseDocument(JSON.stringify(valid));
  assert.equal(tree.nodes.get(2)?.text, '42');
  assert.ok(Object.isFrozen(tree));
  assert.ok(Object.isFrozen(tree.nodes.get(1)));
  assert.ok(Object.isFrozen(tree.nodes.get(1)?.children));
  assert.ok(Object.isFrozen(tree.nodes.get(1)?.attributes));
});

test('invalid snapshots cannot expose cycles, missing children, duplicate or unsafe IDs', () => {
  assert.throws(() => parseDocument(JSON.stringify({ ...valid, nodes: [valid.nodes[0]] })), /Missing/);
  assert.throws(() => parseDocument(JSON.stringify({ ...valid, nodes: [...valid.nodes, valid.nodes[2]] })), /Duplicate/);
  assert.throws(() => parseDocument(JSON.stringify({ root: 0, nodes: [{ id: 0, kind: 'root', children: [0] }] })), /not a tree/);
  assert.throws(() => parseDocument(JSON.stringify({ root: 0, nodes: [
    { id: 0, kind: 'root', children: [1] }, { id: 1, kind: 'text', text: 'x', children: [0] },
  ] })), /text node/);
  assert.throws(() => parseDocument(JSON.stringify({ root: 0, nodes: [
    { id: 0, kind: 'root', children: [] }, { id: Number.MAX_SAFE_INTEGER + 1, kind: 'text', text: 'x', children: [] },
  ] })), /Invalid/);
});

test('phx-click passes only phx-value attributes and safely handles prototype names', () => {
  const click = clickEvent({
    'phx-click': 'increment', 'phx-value-step': '2', 'phx-value-__proto__': 'literal',
    'phx-value-missing': null, onPress: 'execute()', arbitrary: 'ignored',
  });
  assert.equal(click?.event, 'increment');
  assert.deepEqual(Object.keys(click!.value), ['step', '__proto__']);
  assert.equal(click?.value.step, '2');
  assert.equal(Object.getPrototypeOf(click!.value), Object.prototype);
  assert.equal(JSON.parse(JSON.stringify(click!.value)).__proto__, 'literal');
  assert.equal(clickEvent({}), null);
});

test('patches share unchanged branches and invalidate changed ancestors', async () => {
  const { applyDocumentPatch } = await import('../src/document');
  const first = parseDocument(JSON.stringify({root:0,nodes:[
    {id:0,kind:'root',children:[1,3]}, {id:1,kind:'element',tag:'Text',children:[2]},
    {id:2,kind:'text',text:'before',children:[]}, {id:3,kind:'text',text:'stable',children:[]},
  ]}));
  const next = applyDocumentPatch(first, JSON.stringify({baseRevision:4,revision:5,root:0,upsert:[{id:2,kind:'text',text:'after',children:[]}],remove:[]}),4,5);
  assert.equal(next.nodes.get(3), first.nodes.get(3));
  assert.equal(next.nodes.get(1), first.nodes.get(1));
  assert.equal(next.subtreeVersions?.get(3), first.subtreeVersions?.get(3));
  assert.equal(next.subtreeVersions?.get(1), first.subtreeVersions!.get(1)!+1);
  assert.equal(next.subtreeVersions?.get(0), first.subtreeVersions!.get(0)!+1);
  const resync = parseDocument(JSON.stringify({root:next.root,nodes:[...next.nodes.values()]}), next);
  assert.equal(resync.nodes.get(2), next.nodes.get(2));
  assert.equal(resync.subtreeVersions?.get(0), next.subtreeVersions?.get(0));
});

test('patch removal/reordering validates final tree atomically', async () => {
  const { applyDocumentPatch } = await import('../src/document');
  const first = parseDocument(JSON.stringify(valid));
  const patch=(upsert:unknown[],remove:number[])=>JSON.stringify({baseRevision:1,revision:2,root:0,upsert,remove});
  assert.throws(()=>applyDocumentPatch(first,patch([],[2]),1,2),/Missing/);
  assert.throws(()=>applyDocumentPatch(first,patch([{id:2,kind:'text',text:'bad',children:[]}],[2]),1,2),/Duplicate/);
  assert.throws(()=>applyDocumentPatch(first,patch([],[99]),1,2),/removal/);
  assert.throws(()=>applyDocumentPatch(first,patch([{id:1,kind:'element',tag:'Text',children:[0]}],[]),1,2),/tree/);
  assert.equal(first.nodes.get(2)?.text,'42');
  const removed = applyDocumentPatch(first,patch([{id:1,kind:'element',tag:'Text',children:[]}],[2]),1,2);
  assert.equal(removed.nodes.size,2);
  assert.throws(()=>applyDocumentPatch(first,patch([],[]),0,2),/envelope/);
});

test('bounded decoding rejects excessive UTF8 bytes and deeply nested trees', () => {
  assert.throws(()=>parseDocument(JSON.stringify({root:0,nodes:[{id:0,kind:'root',children:[1]},{id:1,kind:'text',text:'🎯'.repeat(1024*1024+1),children:[]}]})),/byte limit/);
  const nodes=Array.from({length:258},(_,id)=>({id,kind:id===0?'root':'element',tag:'View',children:id===257?[]:[id+1]}));
  assert.throws(()=>parseDocument(JSON.stringify({root:0,nodes})),/depth/);
});

test('small individual patches cannot grow the retained document past its byte bound', async () => {
  const { applyDocumentPatch } = await import('../src/document');
  const first=parseDocument(JSON.stringify({root:0,nodes:[{id:0,kind:'root',children:[1,2]},
    {id:1,kind:'text',text:'a'.repeat(3*1024*1024),children:[]},{id:2,kind:'text',text:'small',children:[]}]}));
  assert.throws(()=>applyDocumentPatch(first,JSON.stringify({baseRevision:1,revision:2,root:0,upsert:[
    {id:2,kind:'text',text:'b'.repeat(2*1024*1024),children:[]}],remove:[]}),1,2),/byte limit/);
  assert.equal(first.nodes.get(2)?.text,'small');
});
