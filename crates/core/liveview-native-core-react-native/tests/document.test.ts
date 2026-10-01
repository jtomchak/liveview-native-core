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
