import test from 'node:test';
import assert from 'node:assert/strict';
import { checklistRoute, committedNavigation, shouldMirrorCommit, navigationAdvanced, isCurrentRequest } from './navigationState.ts';

test('only installed checklist paths are accepted', () => {
  assert.equal(checklistRoute('http://localhost:4001/checklists/workshop/tasks/workshop-1?filter=active'), '/checklists/workshop/tasks/workshop-1');
  assert.equal(checklistRoute('/'), '/checklists');
  for (const route of ['/session', '/checklists/x/unknown', '/checklists/%2e%2e/session', '/settings']) assert.equal(checklistRoute(route), null);
});
test('native commits mirror once, while auth transitions reset the app stack', () => {
  assert.equal(committedNavigation('/checklists/a', '/checklists', '/checklists', null, 2), 'push');
  assert.equal(committedNavigation('/checklists/a', '/checklists/a', '/checklists', null, 2), 'none');
  assert.equal(committedNavigation('/sign-in', '/checklists/a', '/checklists/a', null, 3), 'reset');
  assert.equal(committedNavigation('/checklists', '/sign-in', '/sign-in', null, 4), 'reset');
});
test('old snapshots cannot undo a pending navigation; back follows core history', () => {
  const intent = { path: '/checklists/a', kind: 'push', generation: 1 };
  assert.equal(committedNavigation('/checklists', '/checklists/a', '/checklists', intent, 1), 'wait');
  assert.equal(committedNavigation('/checklists/a', '/checklists', '/checklists', intent, 2), 'push');
  assert.equal(committedNavigation('/checklists', '/checklists/a', '/checklists/a', { ...intent, path: null, kind: 'back', generation: 2 }, 3), 'back');
});

test('a fresh Expo deep link is not overwritten by the unchanged native document', () => {
  assert.equal(shouldMirrorCommit('/checklists', '/checklists/a', '/checklists', 2, 2, null), false);
  assert.equal(shouldMirrorCommit('/checklists/a', '/checklists', '/checklists', 3, 2, null), true);
  assert.equal(shouldMirrorCommit('/checklists', '/checklists/a', '/checklists', 3, 2, null), true);
});

test('same-path history and query transitions can complete without a new document', () => {
  assert.equal(navigationAdvanced({ url: '/checklists/a', historyId: '1' }, { url: '/checklists/a', historyId: '2' }), true);
  assert.equal(navigationAdvanced({ url: '/checklists/a?q=1', historyId: '1' }, { url: '/checklists/a?q=2', historyId: '1' }), true);
  assert.equal(navigationAdvanced({ url: '/checklists/a', historyId: '1' }, { url: '/checklists/a', historyId: '1' }), false);
});
test('an old failed request cannot clear its successor', () => {
  const request = { path: null, kind: 'back', generation: 1 };
  assert.equal(isCurrentRequest(request, request), true);
  assert.equal(isCurrentRequest({ ...request }, request), false);
  assert.equal(isCurrentRequest(null, request), false);
});

test('a pending request cannot settle a replacement client session', () => {
  const request = { path: '/checklists/a', kind: 'push', generation: 3 };
  assert.equal(isCurrentRequest(request, request, 'session-1', 'session-1'), true);
  assert.equal(isCurrentRequest(request, request, 'session-1', 'session-2'), false);
  assert.equal(isCurrentRequest(request, request, 'session-1', null), false);
});
