/** Only installed application routes can be mirrored into the native navigator. */
export function checklistRoute(value: string): string | null {
  try {
    const url = new URL(value, 'https://checklist.invalid');
    const path = url.pathname.replace(/\/$/, '') || '/';
    if (path === '/' || path === '/checklists') return '/checklists';
    if (path === '/sign-in') return path;
    if (/^\/checklists\/[A-Za-z0-9_-]+(?:\/tasks\/[A-Za-z0-9_-]+(?:\/edit)?)?$/.test(path)) return path;
  } catch {}
  return null;
}

export type NavigationIntent = { path: string | null; kind: 'push' | 'replace' | 'back'; generation: number };
export function committedNavigation(
  path: string, visible: string, previous: string | null, intent: NavigationIntent | null, generation: number,
): 'none' | 'wait' | 'push' | 'replace' | 'back' | 'reset' {
  if (path === visible) return 'none';
  if (path === '/sign-in' || previous === '/sign-in' || previous === null) return 'reset';
  // A late snapshot from the old document must not undo an outstanding navigation.
  if (intent && generation <= intent.generation && path !== intent.path) return 'wait';
  if (intent?.kind === 'back') return 'back';
  if (intent?.kind === 'replace') return 'replace';
  return 'push';
}

export function shouldMirrorCommit(path: string, visible: string, previous: string | null, generation: number, previousGeneration: number, mirrored: string | null) {
  return !(path === previous && path !== visible && mirrored !== path && generation <= previousGeneration);
}

export function navigationAdvanced(before: { url: string | null; historyId?: string | null }, after: { url: string | null; historyId?: string | null }) {
  return before.url !== after.url || (typeof before.historyId === 'string' && typeof after.historyId === 'string' && before.historyId !== after.historyId);
}
export function isCurrentRequest(current: NavigationIntent | null, request: NavigationIntent, requestSession?: string | null, activeSession?: string | null) {
  return current === request && requestSession === activeSession;
}

export function offlineParentRoute(path: string): string | null {
  const route = checklistRoute(path);
  if (!route || route === '/checklists' || route === '/sign-in') return null;
  if (route.endsWith('/edit')) return route.slice(0, -5);
  const tasks = route.indexOf('/tasks/');
  return tasks >= 0 ? route.slice(0, tasks) : '/checklists';
}

export function endpointChange(current: string, next: string) {
  const before = new URL(current); const target = new URL(next);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use a supported endpoint without embedded credentials');
  return { url: target.toString(), origin: target.origin, originChanged: before.origin !== target.origin, sameEndpoint: before.toString() === target.toString() };
}
export function bindEndpointScope(repository: { bindOrigin(origin: string): void }, change: ReturnType<typeof endpointChange>) {
  if (change.originChanged) repository.bindOrigin(change.origin);
}
