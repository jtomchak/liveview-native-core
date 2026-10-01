/** Only installed application routes can be mirrored into the native navigator. */
export function checklistRoute(value: string): string | null {
  try {
    const url = new URL(value, 'https://checklist.invalid');
    const path = url.pathname.replace(/\/$/, '') || '/';
    if (path === '/' || path === '/checklists') return '/checklists';
    if (path === '/sign-in') return path;
    if (/^\/checklists\/[A-Za-z0-9_-]+(?:\/tasks\/[A-Za-z0-9_-]+)?$/.test(path)) return path;
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
