import assert from 'node:assert/strict';
import test from 'node:test';
import { DiagnosticBuffer } from '../example/diagnostics';
test('commit instrumentation cannot trigger external-store consistency renders and buffer is bounded', () => {
  const buffer = new DiagnosticBuffer();
  const before = buffer.getSnapshot();
  assert.equal(buffer.record({ name: 'lvn.react.commit', at: 1, attributes: {} }), false);
  assert.equal(buffer.getSnapshot(), before);
  for (let i=0; i<200; i++) buffer.record({ name: 'lvn.document.received', at: i, attributes: {} });
  assert.equal(buffer.getSnapshot().length, 120);
  assert.equal(buffer.getSnapshot()[0].at, 80);
});
