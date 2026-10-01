import { DatabaseSync } from 'node:sqlite';
import { OfflineRepository } from './offlineRepository.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checklistRoute, committedNavigation, shouldMirrorCommit, navigationAdvanced, isCurrentRequest, isCurrentDocumentCommit, isCurrentLinkIntent, offlineParentRoute, offlineRestoreTarget, endpointChange, bindEndpointScope, reconnectUrl } from './navigationState.ts';

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

test('passive Router bounces restore the native projection rather than become commands', () => {
  assert.equal(shouldMirrorCommit('/checklists/a', 8), true);
  assert.equal(committedNavigation('/checklists/a', '/checklists/a/tasks/t', '/checklists/a', null, 8), 'replace');
});
test('only an explicit installed OS link holds an older native projection', () => {
  const link = { path: '/checklists/a', nonce: 1 };
  assert.equal(shouldMirrorCommit('/checklists', 2, link), false);
  assert.equal(shouldMirrorCommit('/checklists', 2, link, 2), false);
  assert.equal(shouldMirrorCommit('/checklists/a', 2, link), true);
  assert.equal(shouldMirrorCommit('/checklists/a', 3, link, 2), true);
  // A new native document can redirect a protected link to sign-in.
  assert.equal(shouldMirrorCommit('/sign-in', 3, link, 2), true);
});
test('an old OS-link settlement cannot consume a newer nonce or path', () => {
  const first = { path: '/checklists/a', nonce: 1 };
  assert.equal(isCurrentLinkIntent(first, first), true);
  assert.equal(isCurrentLinkIntent({ ...first, nonce: 2 }, first), false);
  assert.equal(isCurrentLinkIntent({ ...first, path: '/checklists/b' }, first), false);
  assert.equal(isCurrentLinkIntent(null, first), false);
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

test('an async mirror cannot settle after a newer document renders before effect cleanup', async () => {
  const captured = { committed: '/checklists/a/tasks/t', sessionId: 'session-1', generation: 7 };
  let latest = captured;
  let resolveHistory;
  const history = new Promise(resolve => { resolveHistory = resolve; });
  let mirrored = null;
  const settlement = history.then(() => { if (isCurrentDocumentCommit(latest, captured)) mirrored = captured.committed; });
  latest = { ...captured, committed: '/checklists/a', generation: 8 };
  resolveHistory(); await settlement;
  assert.equal(mirrored, null);
  assert.equal(isCurrentDocumentCommit({ ...captured, generation: 8 }, captured), false);
  assert.equal(isCurrentDocumentCommit({ ...captured, sessionId: 'session-2' }, captured), false);
  assert.equal(isCurrentDocumentCommit(captured, captured), true);
});

test('offline back follows installed route parents rather than server history', () => {
  assert.equal(offlineParentRoute('/checklists/a/tasks/t/edit'), '/checklists/a/tasks/t');
  assert.equal(offlineParentRoute('/checklists/a/tasks/t'), '/checklists/a');
  assert.equal(offlineParentRoute('/checklists/a'), '/checklists');
  assert.equal(offlineParentRoute('/checklists'), null);
  assert.equal(offlineParentRoute('/sign-in'), null);
});
test('transient connecting fallback cannot restore an old visible route; explicit offline edits can restore', () => {
  // A core server replacement task -> detail passes through connecting. It
  // leaves the explicit offline-route slot empty, regardless of old pathname.
  assert.equal(offlineRestoreTarget(null, '/checklists/a'), null);
  assert.equal(committedNavigation('/checklists/a', '/checklists/a/tasks/t', '/checklists/a/tasks/t', null, 7), 'push');
  const editedOffline = '/checklists/a/tasks/t/edit';
  assert.equal(offlineRestoreTarget(editedOffline, '/checklists'), editedOffline);
  assert.equal(offlineRestoreTarget(editedOffline, editedOffline), null);
});

test('reconnecting uses the active installed route on the configured origin', () => {
  const endpoint = 'http://localhost:4001/checklists';
  assert.equal(reconnectUrl(endpoint, '/checklists/a/tasks/t/edit'), 'http://localhost:4001/checklists/a/tasks/t/edit');
  assert.equal(reconnectUrl(endpoint, '/checklists/a'), 'http://localhost:4001/checklists/a');
  assert.equal(reconnectUrl(endpoint, '/sign-in'), 'http://localhost:4001/sign-in');
  assert.equal(reconnectUrl(endpoint, 'https://other.invalid/checklists/a'), 'http://localhost:4001/checklists/a');
  assert.equal(reconnectUrl(endpoint, '/session'), endpoint);
  assert.equal(reconnectUrl(endpoint, null), endpoint);
});

test('endpoint reconnects and route changes preserve actual SQLite cache and drafts; a new origin clears them', () => {
  const db = new DatabaseSync(':memory:');
  const driver = { exec: sql => db.exec(sql), run: (sql, ...params) => { db.prepare(sql).run(...params); }, all: (sql, ...params) => db.prepare(sql).all(...params), first: (sql, ...params) => db.prepare(sql).get(...params) ?? null };
  const repository = new OfflineRepository(driver, 'http://localhost:4001');
  const records = JSON.stringify([{ id: 'list-1', title: 'List', tasks: [{ id: 'task-1', title: 'Task', notes: '', completed: false, version: 3, attachments: [] }] }]);
  const draft = { fields: { 'task[id]': 'task-1', 'task[version]': '2', 'task[title]': 'Keep this', 'task[notes]': 'Unsaved', 'task[completed]': 'false' }, sequence: 4 };
  repository.capture('workshop', records); repository.set('workshop:task-1', draft);
  const same = endpointChange('http://localhost:4001/checklists', 'http://localhost:4001/checklists');
  assert.equal(same.sameEndpoint, true); bindEndpointScope(repository, same);
  assert.deepEqual(repository.get('workshop:task-1'), draft); assert.equal(repository.getSnapshot().account, 'workshop');
  const route = endpointChange(same.url, 'http://localhost:4001/checklists/list-1/tasks/task-1/edit');
  assert.equal(route.originChanged, false); bindEndpointScope(repository, route);
  assert.deepEqual(repository.get('workshop:task-1'), draft); assert.equal(repository.getSnapshot().records.length, 1);
  const foreign = endpointChange(route.url, 'http://localhost:4002/checklists');
  assert.equal(foreign.originChanged, true); bindEndpointScope(repository, foreign);
  assert.equal(repository.getSnapshot().account, null); assert.equal(repository.get('workshop:task-1'), undefined);
  assert.equal(db.prepare('SELECT count(*) AS count FROM offline_drafts').get().count, 0); db.close();
});
