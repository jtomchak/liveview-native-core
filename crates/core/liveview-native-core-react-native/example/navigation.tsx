import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BackHandler, Linking, Platform } from 'react-native';
import { getLinkingURL } from 'expo-linking';
import { usePathname, useRouter, type Href } from 'expo-router';
import { measure, useLiveView, type LiveViewSession } from '@liveview-native/react-native';
import { openOfflineRepository } from './offlineDatabase';
import { OutboxRunner } from './outbox';
import type { OfflineRepository, OfflineSnapshot } from './offlineRepository';
import { checklistRoute, offlineParentRoute, offlineRestoreTarget, endpointChange, bindEndpointScope, reconnectUrl, committedNavigation, shouldMirrorCommit, navigationAdvanced, isCurrentRequest, isCurrentDocumentCommit, isCurrentLinkIntent, type NavigationIntent, type InstalledLinkIntent } from './navigationState';

function installedLinkPath(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'lvn-checklist:') return null;
    return checklistRoute(`${url.hostname ? `/${url.hostname}` : ''}${url.pathname}`);
  } catch { return null; }
}

const defaultEndpoint = Platform.OS === 'android' ? 'http://10.0.2.2:4001/checklists' : 'http://127.0.0.1:4001/checklists';
type NavigationContext = {
  live: Omit<LiveViewSession, 'retry'> & { retry(): void };
  draftStore: OfflineRepository;
  repository: OfflineRepository;
  cached: OfflineSnapshot;
  offline: boolean;
  visiblePath: string;
  repositoryError: string | null;
  verifiedAccount: string | null;
  endpoint: string;
  setEndpoint(endpoint: string): void;
  coherent: boolean;
  canGoBack: boolean;
};
const Context = createContext<NavigationContext | null>(null);

export function ChecklistNavigationProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const visible = checklistRoute(pathname) ?? '/checklists';
  const [endpoint, updateEndpoint] = useState(() => new URL(visible, defaultEndpoint).toString());
  const native = useLiveView({ url: endpoint, suspendInBackground: false });
  const [repository] = useState(() => openOfflineRepository(new URL(endpoint).origin));
  const [outbox] = useState(() => new OutboxRunner(repository, (name, attributes) => measure(name, attributes)));
  const draftStore = repository;
  const cached = useSyncExternalStore(repository.subscribe, repository.getSnapshot, repository.getSnapshot);
  const offline = native.status !== 'connected' && cached.account !== null;
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const offlineRoute = useRef<string | null>(null);
  const offlineAccount = useRef<string | null>(null);
  const restoreRequest = useRef<string | null>(null);
  const blockedSessions = useRef(new Set<string>());
  const captureOrigin = useRef(new URL(endpoint).origin);
  const captured = useRef<{ account: string; records: string; session: string | null } | null>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const previous = useRef<string | null>(null);
  const previousGeneration = useRef(-1);
  const intent = useRef<NavigationIntent | null>(null);
  const mirrored = useRef<string | null>(null);
  const mirrorRequest = useRef(0);
  const lastRequested = useRef<string | null>(null);
  const activeSession = useRef(native.sessionId);
  activeSession.current = native.sessionId;
  const knownSession = useRef(native.sessionId);
  const [linkIntent, setLinkIntent] = useState<InstalledLinkIntent | null>(null);
  const latestLink = useRef<InstalledLinkIntent | null>(null);
  const linkNonce = useRef(0);
  const runningLink = useRef<{ intent: InstalledLinkIntent; sessionId: string | null; generation: number } | null>(null);
  const linkDiagnostic = useRef({ initialPath: null as string | null, lastEventPath: null as string | null, eventCount: 0 });
  useEffect(() => {
    let mounted = true;
    const accept = (path: string) => {
      const request = { path, nonce: ++linkNonce.current };
      latestLink.current = request; setLinkIntent(request);
    };
    void Linking.getInitialURL().then(url => {
      if (!mounted) return;
      const path = installedLinkPath(url); linkDiagnostic.current.initialPath = path;
      // A late initial URL must not replace a newer foreground URL or an
      // explicit user reset. Initial links are handled once per provider mount.
      if (path && linkNonce.current === 0) accept(path);
    }).catch(() => {});
    const listener = Linking.addEventListener('url', event => {
      const path = installedLinkPath(event.url);
      if (path) { linkDiagnostic.current.lastEventPath = path; linkDiagnostic.current.eventCount++; accept(path); }
    });
    return () => { mounted = false; listener.remove(); };
  }, []);
  const cancelLink = useCallback(() => {
    linkNonce.current++; latestLink.current = null; runningLink.current = null; setLinkIntent(null);
  }, []);
  useEffect(() => {
    if (knownSession.current === native.sessionId) return;
    knownSession.current = native.sessionId;
    intent.current = null; lastRequested.current = null; mirrored.current = null;
    previous.current = null; previousGeneration.current = -1; setCanGoBack(false);
  }, [native.sessionId]);
  const setEndpoint = useCallback((value: string) => {
    const change = endpointChange(endpoint, value);
    const reconnect = reconnectUrl(endpoint, offline ? offlineRoute.current ?? visible : latestDocument.current.committed);
    cancelLink();
    outbox.setConnection(native, null);
    if (native.sessionId) blockedSessions.current.add(native.sessionId);
    captureOrigin.current = change.origin; captured.current = null; offlineRoute.current = null; restoreRequest.current = null;
    previous.current = null; previousGeneration.current = -1; intent.current = null;
    mirrored.current = null; lastRequested.current = null; setCanGoBack(false);
    bindEndpointScope(repository, change); setRepositoryError(null);
    if (change.sameEndpoint) native.retry(reconnect);
    else updateEndpoint(change.url);
  }, [repository, native, outbox, endpoint, offline, visible, cancelLink]);
  const route = [...(native.document?.nodes.values() ?? [])]
    .map(node => node.attributes?.['data-route']).find(Boolean);
  const committed = route ? checklistRoute(route) : null;
  const latestDocument = useRef({ committed, parentRoute: null as string | null, sessionId: native.sessionId, generation: native.documentGeneration });
  const parentRoute = [...(native.document?.nodes.values() ?? [])]
    .map(node => node.attributes?.['data-parent-route']).find(Boolean);
  latestDocument.current = { committed, parentRoute: parentRoute ?? null, sessionId: native.sessionId, generation: native.documentGeneration };
  const retry = useCallback(() => {
    const target = reconnectUrl(endpoint, offline ? visible : latestDocument.current.committed);
    cancelLink();
    outbox.setConnection(native, null);
    if (native.sessionId) blockedSessions.current.add(native.sessionId);
    captured.current = null; intent.current = null; lastRequested.current = null; mirrored.current = null;
    native.retry(target);
  }, [endpoint, offline, visible, outbox, native, cancelLink]);

  const performNavigation = useCallback(async (request: NavigationIntent, operation: () => Promise<void>, targetUrl?: string) => {
    const requestSession = native.sessionId;
    intent.current = request; lastRequested.current = request.path;
    const ownsRequest = () => isCurrentRequest(intent.current, request, requestSession, activeSession.current);
    const clear = () => {
      if (ownsRequest()) { intent.current = null; lastRequested.current = null; }
    };
    try {
      const before = await native.getNavigation();
      if (!ownsRequest()) return;
      // Avoid adding duplicate exact URLs to core history. Query changes remain
      // supported and are acknowledged by history identity even without remounts.
      if (request.kind === 'push' && targetUrl === before.url) { clear(); return; }
      await operation();
      for (let attempts = 0; attempts < 100 && ownsRequest(); attempts++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!ownsRequest()) return;
        const state = await native.getNavigation().catch(() => null);
        if (!ownsRequest()) return;
        if (!state) continue; // Joining a replacement document can briefly be disconnected.
        const currentDocument = latestDocument.current;
        if (navigationAdvanced(before, state) && state.url && checklistRoute(state.url) === currentDocument.committed) {
          // Different routes are mirrored by the document effect. This handles
          // same-path back/forward/query changes that produce no route effect.
          if (currentDocument.committed === previous.current) {
            clear();
            setCanGoBack(Boolean(state.canGoBack && currentDocument.parentRoute && currentDocument.committed !== '/sign-in'));
            return;
          }
        }
        if (request.kind === 'replace' && targetUrl === before.url && state.url === targetUrl) { clear(); return; }
      }
      if (ownsRequest()) throw new Error('Navigation did not commit within 10 seconds');
    } catch (error) {
      if (ownsRequest()) {
        const fallback = latestDocument.current.committed;
        clear();
        if (fallback) { mirrored.current = fallback; router.replace(fallback as Href); }
      }
      throw error;
    }
  }, [native.getNavigation, native.sessionId, router]);
  const navigate = useCallback(async (url: string, replace = false) => {
    const target = new URL(url, endpoint);
    const path = checklistRoute(target.toString());
    if (!path || target.username || target.password || target.origin !== new URL(endpoint).origin) throw new Error('Unsupported checklist route');
    if (offline) {
      offlineRoute.current = path; offlineAccount.current = cached.account;
      if (replace) router.replace(path as Href); else router.push(path as Href);
      return;
    }
    const request: NavigationIntent = { path, kind: replace ? 'replace' : 'push', generation: native.documentGeneration };
    await performNavigation(request, () => native.navigate(target.toString(), replace), target.toString());
  }, [endpoint, native.navigate, native.documentGeneration, performNavigation, offline, cached.account, router]);
  const back = useCallback(async () => {
    if (offline) { const parent = offlineParentRoute(visible); if (parent) await navigate(parent, true); return; }
    if (!canGoBack || intent.current?.kind === 'back') return;
    const request: NavigationIntent = { path: null, kind: 'back', generation: native.documentGeneration };
    await performNavigation(request, native.back);
  }, [canGoBack, native.back, native.documentGeneration, performNavigation, offline, visible, navigate]);
  const forward = useCallback(async () => {
    if (offline) return;
    const request: NavigationIntent = { path: null, kind: 'push', generation: native.documentGeneration };
    await performNavigation(request, native.forward);
  }, [native.forward, native.documentGeneration, performNavigation, offline]);
  const logout = useCallback(async (url: string) => {
    cancelLink();
    outbox.setConnection(native, null);
    if (native.sessionId) blockedSessions.current.add(native.sessionId);
    captured.current = null; offlineRoute.current = null; restoreRequest.current = null;
    intent.current = null; lastRequested.current = null; previous.current = null; setCanGoBack(false);
    try { draftStore.clear(); } catch { setRepositoryError('Device cache cleanup failed.'); }
    await native.logout(url);
  }, [native, draftStore, outbox, cancelLink]);
  const currentAccount = [...(native.document?.nodes.values() ?? [])].map(node => node.attributes?.['data-account']).find(Boolean);
  const signedOut = [...(native.document?.nodes.values() ?? [])].some(node => node.attributes?.['data-auth'] === 'signed-out');
  const signedIn = [...(native.document?.nodes.values() ?? [])].some(node => node.attributes?.['data-auth'] === 'signed-in');
  const recordsJson = [...(native.document?.nodes.values() ?? [])].map(node => node.attributes?.['data-records']).find(Boolean);
  const getVerifiedAccount = () => native.status === 'connected' && signedIn && !signedOut && native.sessionId &&
    !blockedSessions.current.has(native.sessionId) && new URL(endpoint).origin === captureOrigin.current &&
    currentAccount === repository.getSnapshot().account && captured.current?.account === currentAccount &&
    captured.current.records === recordsJson && captured.current.session === native.sessionId ? currentAccount ?? null : null;
  const verifiedAccount = getVerifiedAccount();
  useEffect(() => {
    if (native.status !== 'connected' || !native.sessionId || blockedSessions.current.has(native.sessionId) || new URL(endpoint).origin !== captureOrigin.current) return;
    try {
      if (signedOut) { captured.current = null; if (cached.account !== null) repository.clear(); return; }
      if (!signedIn || !currentAccount || !recordsJson) return;
      if (cached.account && cached.account !== currentAccount) { repository.clear(); captured.current = null; }
      const previousCapture = captured.current;
      if (previousCapture?.account === currentAccount && previousCapture.records === recordsJson && previousCapture.session === native.sessionId) return;
      repository.capture(currentAccount, recordsJson);
      captured.current = { account: currentAccount, records: recordsJson, session: native.sessionId };
      setRepositoryError(null);
    } catch { setRepositoryError('Device cache storage failed.'); }
  }, [native.status, native.sessionId, endpoint, signedOut, signedIn, currentAccount, recordsJson, repository, cached.account]);
  useEffect(() => {
    // Native navigation can briefly publish "connecting". Showing the cache
    // does not create a route intent; only explicit offline navigate() does.
    if (offline) { restoreRequest.current = null; return; }
    if (!offlineRoute.current || native.status !== 'connected' || !committed) return;
    if (signedOut || (currentAccount && currentAccount !== offlineAccount.current)) { offlineRoute.current = null; restoreRequest.current = null; return; }
    const target = offlineRestoreTarget(offlineRoute.current, committed);
    if (!target) { offlineRoute.current = null; restoreRequest.current = null; return; }
    const requestKey = `${native.sessionId}:${target}`;
    if (restoreRequest.current === requestKey) return;
    restoreRequest.current = requestKey;
    void navigate(target, true).catch(() => { offlineRoute.current = null; restoreRequest.current = null; });
  }, [offline, visible, cached.account, native.status, native.sessionId, committed, currentAccount, signedOut, navigate]);
  const live = useMemo(() => ({ ...native, navigate, back, forward, logout, retry }), [native, navigate, back, forward, logout, retry]);
  // Runs after capture: the synchronous SQL transaction must finish before a
  // persisted account can authorize command transport for this live session.
  useEffect(() => { outbox.setConnection(live, getVerifiedAccount()); }, [outbox, live, verifiedAccount, recordsJson, signedIn, signedOut, currentAccount, endpoint]);
  useEffect(() => () => outbox.dispose(), [outbox]);
  useEffect(() => { if (__DEV__) {
    (globalThis as any).__lvnSession = live;
    (globalThis as any).__lvnOffline = repository;
    (globalThis as any).__lvnOutbox = outbox;
    (globalThis as any).__lvnSetEndpoint = (value: string) => setEndpoint(value);
    (globalThis as any).__lvnRoute = () => ({ pathname, committedRoute: committed, pending: intent.current?.path ?? null,
      mirrored: mirrored.current, previousRoute: previous.current, previousGeneration: previousGeneration.current,
      linkIntent: latestLink.current, runningLink: runningLink.current?.intent.nonce ?? null,
      linking: { ...linkDiagnostic.current, expoCachedPath: installedLinkPath(getLinkingURL()) } });
  } }, [live, pathname, committed, setEndpoint, repository, outbox]);

  useEffect(() => {
    if (!committed || native.status !== 'connected' || offline || offlineRoute.current) return;
    const link = latestLink.current;
    const linkRequest = runningLink.current;
    const linkGeneration = link && linkRequest && isCurrentLinkIntent(link, linkRequest.intent) && linkRequest.sessionId === native.sessionId ? linkRequest.generation : null;
    if (!shouldMirrorCommit(committed, native.documentGeneration, link, linkGeneration)) return;
    const proposed = committedNavigation(committed, visible, previous.current, intent.current, native.documentGeneration);
    if (proposed === 'wait') return;
    // Reserve this projection before reading history; settlement still checks
    // the latest native document identity before changing the Router.
    if (proposed !== 'none') mirrored.current = committed;
    const committingRequest = intent.current;
    const committingSession = native.sessionId;
    const committingDocument = { committed, sessionId: native.sessionId, generation: native.documentGeneration };
    const committingMirror = ++mirrorRequest.current;
    let current = true;
    void native.getNavigation().catch(() => ({ canGoBack: false, action: null })).then(state => {
      if (!current || committingMirror !== mirrorRequest.current || !isCurrentDocumentCommit(latestDocument.current, committingDocument) ||
        activeSession.current !== committingSession || (intent.current !== null && intent.current !== committingRequest)) return;
      let action = proposed;
      if (action === 'push' && state.action?.toLowerCase() === 'replace') action = 'replace';
      previous.current = committed;
      previousGeneration.current = native.documentGeneration;
      intent.current = null; lastRequested.current = null;
      if (action !== 'none') {
        mirrored.current = committed;
        if (action === 'reset') { if (router.canDismiss()) router.dismissAll(); router.replace(committed as Href); }
        else if (action === 'back') router.dismissTo(committed as Href);
        else if (action === 'replace') router.replace(committed as Href);
        else router.push(committed as Href);
        measure('navigation.committed', { documentGeneration: native.documentGeneration });
      }
      setCanGoBack(Boolean(state.canGoBack && parentRoute && committed !== '/sign-in'));
    }).catch(() => {});
    return () => { current = false; };
  }, [committed, parentRoute, native.sessionId, native.documentGeneration, visible, native.getNavigation, router, native.status, offline, linkIntent]);

  useEffect(() => {
    if (mirrored.current === visible) mirrored.current = null;
  }, [visible]);
  useEffect(() => {
    if (!linkIntent || !isCurrentLinkIntent(latestLink.current, linkIntent)) return;
    if (!offline && native.status !== 'connected') return;
    const active = runningLink.current;
    if (active && isCurrentLinkIntent(linkIntent, active.intent) && active.sessionId === native.sessionId) return;
    if (!offline && committed === linkIntent.path) {
      latestLink.current = null; setLinkIntent(null); return;
    }
    const request = { intent: linkIntent, sessionId: native.sessionId, generation: native.documentGeneration };
    runningLink.current = request;
    const finish = () => {
      if (runningLink.current !== request || !isCurrentLinkIntent(latestLink.current, request.intent)) return;
      runningLink.current = null;
      if (request.sessionId !== activeSession.current) {
        // The old client's promise cannot consume an intent for its successor.
        setLinkIntent({ ...request.intent }); return;
      }
      latestLink.current = null; setLinkIntent(null);
    };
    // Installed OS links are the only Router-to-core inputs. Passive pathname
    // changes can be stale navigator projections and never enqueue core work.
    void navigate(linkIntent.path, true).then(finish, finish);
  }, [linkIntent, committed, native.status, native.sessionId, native.documentGeneration, navigate, offline]);
  const effectiveCanGoBack = offline ? Boolean(offlineParentRoute(visible)) : canGoBack;
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!effectiveCanGoBack) { BackHandler.exitApp(); return true; }
      void back().catch(() => {});
      return true;
    });
    return () => listener.remove();
  }, [back, effectiveCanGoBack]);

  const value = useMemo(() => ({ live, draftStore, repository, cached, offline, visiblePath: visible, repositoryError, verifiedAccount, endpoint, setEndpoint, coherent: committed === visible, canGoBack: effectiveCanGoBack }), [live, draftStore, repository, cached, offline, repositoryError, verifiedAccount, endpoint, setEndpoint, committed, visible, effectiveCanGoBack]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useChecklistNavigation() {
  const context = useContext(Context);
  if (!context) throw new Error('ChecklistNavigationProvider is missing');
  return context;
}
