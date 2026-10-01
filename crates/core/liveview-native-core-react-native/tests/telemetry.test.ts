import assert from 'node:assert/strict';
import test from 'node:test';
import { measure, setTelemetrySink } from '../src/telemetry';
test('telemetry is opt-in, timestamps are monotonic, throwing exporters are isolated', () => {
  measure('no_sink');
  const events: any[] = [];
  setTelemetrySink(event => events.push(event));
  measure('first', { durationMs: 2 }); measure('second');
  assert.equal(events[0].name, 'lvn.first');
  assert.ok(events[1].at >= events[0].at);
  setTelemetrySink(() => { throw new Error('backend unavailable'); });
  assert.doesNotThrow(() => measure('safe'));
  setTelemetrySink();
});
