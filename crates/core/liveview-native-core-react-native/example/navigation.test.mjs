import { DatabaseSync } from 'node:sqlite';
import { OfflineRepository } from './offlineRepository.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checklistRoute, committedNavigation, shouldMirrorCommit, navigationAdvanced, isCurrentRequest, offlineParentRoute, endpointChange, bindEndpointScope } from './navigationState.ts';

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

test('offline back follows installed route parents rather than server history', () => {
  assert.equal(offlineParentRoute('/checklists/a/tasks/t/edit'), '/checklists/a/tasks/t');
  assert.equal(offlineParentRoute('/checklists/a/tasks/t'), '/checklists/a');
  assert.equal(offlineParentRoute('/checklists/a'), '/checklists');
  assert.equal(offlineParentRoute('/checklists'), null);
  assert.equal(offlineParentRoute('/sign-in'), null);
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
