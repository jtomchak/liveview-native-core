import assert from 'node:assert/strict';
import test from 'node:test';
import { selectNativeTransport } from '../src/nativeSelection';
import type { LiveViewTransport } from '../src/types';

const transport = (): LiveViewTransport => ({
  async connect() {}, async sendEvent() {}, async disconnect() {}, async postForm() {}, async logout() {},
  addListener() { return { remove() {} }; },
});

test('Android selects only the v2 host while iOS selects its Expo module host', () => {
  const classic = transport();
  const android = transport();
  const v2 = { modules: { LiveViewNative: android } };
  assert.equal(selectNativeTransport('android', classic, v2), android);
  assert.equal(selectNativeTransport('android', classic, undefined), null);
  assert.equal(selectNativeTransport('ios', classic, v2), classic);
  assert.equal(selectNativeTransport('web', classic, v2), null);
});

test('v2 event subscription keeps its host receiver and remove contract', () => {
  const host = transport();
  let removed = false;
  host.addListener = function (_, listener) {
    assert.equal(this, host);
    listener({ sessionId: 's', revision: 1, status: 'connected', document: null, error: null });
    return { remove() { removed = true; } };
  };
  const selected = selectNativeTransport('android', null, { modules: { LiveViewNative: host } })!;
  const subscription = selected.addListener('onUpdate', update => assert.equal(update.sessionId, 's'));
  subscription.remove();
  assert.equal(removed, true);
});

test('an incomplete native build is rejected before transport use', () => {
  const incomplete = { ...transport(), connect: undefined } as unknown as LiveViewTransport;
  assert.equal(selectNativeTransport('android', null, { modules: { LiveViewNative: incomplete } }), null);
});
