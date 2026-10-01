import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Linking, Platform } from 'react-native';
import { getLinkingURL } from 'expo-linking';
import { usePathname, useRouter, type Href } from 'expo-router';
import { measure, MemoryFormDraftStore, useLiveView, type LiveViewSession } from '@liveview-native/react-native';
import { checklistRoute, committedNavigation, shouldMirrorCommit, navigationAdvanced, isCurrentRequest, type NavigationIntent } from './navigationState';

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
  live: LiveViewSession;
  draftStore: MemoryFormDraftStore;
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
  const draftStore = useMemo(() => new MemoryFormDraftStore(), []);
  const [canGoBack, setCanGoBack] = useState(false);
  const previous = useRef<string | null>(null);
  const previousGeneration = useRef(-1);
  const intent = useRef<NavigationIntent | null>(null);
  const mirrored = useRef<string | null>(null);
  const lastRequested = useRef<string | null>(null);
  const activeSession = useRef(native.sessionId);
  activeSession.current = native.sessionId;
  const knownSession = useRef(native.sessionId);
  const linkDiagnostic = useRef({ initialPath: null as string | null, lastEventPath: null as string | null, eventCount: 0 });
  useEffect(() => {
    if (!__DEV__) return;
    void Linking.getInitialURL().then(url => { linkDiagnostic.current.initialPath = installedLinkPath(url); }).catch(() => {});
    const listener = Linking.addEventListener('url', event => {
      const path = installedLinkPath(event.url);
      if (path) { linkDiagnostic.current.lastEventPath = path; linkDiagnostic.current.eventCount++; }
    });
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (knownSession.current === native.sessionId) return;
    knownSession.current = native.sessionId;
    intent.current = null; lastRequested.current = null; mirrored.current = null;
    previous.current = null; previousGeneration.current = -1; setCanGoBack(false);
  }, [native.sessionId]);
  const setEndpoint = useCallback((value: string) => {
    previous.current = null; previousGeneration.current = -1; intent.current = null;
    mirrored.current = null; lastRequested.current = null; setCanGoBack(false);
    draftStore.clear(); updateEndpoint(value);
  }, [draftStore]);
  const route = [...(native.document?.nodes.values() ?? [])]
    .map(node => node.attributes?.['data-route']).find(Boolean);
  const committed = route ? checklistRoute(route) : null;
  const latestDocument = useRef({ committed, parentRoute: null as string | null });
  const parentRoute = [...(native.document?.nodes.values() ?? [])]
    .map(node => node.attributes?.['data-parent-route']).find(Boolean);
  latestDocument.current = { committed, parentRoute: parentRoute ?? null };

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
    const request: NavigationIntent = { path, kind: replace ? 'replace' : 'push', generation: native.documentGeneration };
    await performNavigation(request, () => native.navigate(target.toString(), replace), target.toString());
  }, [endpoint, native.navigate, native.documentGeneration, performNavigation]);
  const back = useCallback(async () => {
    if (!canGoBack || intent.current?.kind === 'back') return;
    const request: NavigationIntent = { path: null, kind: 'back', generation: native.documentGeneration };
    await performNavigation(request, native.back);
  }, [canGoBack, native.back, native.documentGeneration, performNavigation]);
  const forward = useCallback(async () => {
    const request: NavigationIntent = { path: null, kind: 'push', generation: native.documentGeneration };
    await performNavigation(request, native.forward);
  }, [native.forward, native.documentGeneration, performNavigation]);
  const logout = useCallback(async (url: string) => {
    intent.current = null; lastRequested.current = null; previous.current = null; setCanGoBack(false);
    draftStore.clear(); await native.logout(url);
  }, [native.logout, draftStore]);
  const currentAccount = [...(native.document?.nodes.values() ?? [])].map(node => node.attributes?.['data-account']).find(Boolean);
  const previousAccount = useRef<string | null>(null);
  const signedOut = [...(native.document?.nodes.values() ?? [])].some(node => node.attributes?.['data-auth'] === 'signed-out');
  useEffect(() => {
    if (previousAccount.current && (signedOut || (currentAccount && currentAccount !== previousAccount.current))) draftStore.clearAccount(previousAccount.current);
    if (signedOut) previousAccount.current = null;
    else if (currentAccount) previousAccount.current = currentAccount;
  }, [currentAccount, signedOut, draftStore]);
  const live = useMemo(() => ({ ...native, navigate, back, forward, logout }), [native, navigate, back, forward, logout]);
  useEffect(() => { if (__DEV__) {
    (globalThis as any).__lvnSession = live;
    (globalThis as any).__lvnSetEndpoint = (value: string) => setEndpoint(value);
    (globalThis as any).__lvnRoute = () => ({ pathname, committedRoute: committed, pending: intent.current?.path ?? null, linking: { ...linkDiagnostic.current, expoCachedPath: installedLinkPath(getLinkingURL()) } });
  } }, [live, pathname, committed, setEndpoint]);

  useEffect(() => {
    if (!committed) return;
    // An external Router/deep-link change requests core navigation in the next
    // effect. An unchanged native document cannot overwrite that requested URL.
    if (!shouldMirrorCommit(committed, visible, previous.current, native.documentGeneration, previousGeneration.current, mirrored.current)) return;
    const proposed = committedNavigation(committed, visible, previous.current, intent.current, native.documentGeneration);
    if (proposed === 'wait') return;
    // Reserve this mirror before reading native history so the deep-link effect
    // cannot enqueue the old visible URL while the async history read settles.
    if (proposed !== 'none') mirrored.current = committed;
    const committingRequest = intent.current;
    const committingSession = native.sessionId;
    let current = true;
    void native.getNavigation().catch(() => ({ canGoBack: false, action: null })).then(state => {
      if (!current || activeSession.current !== committingSession || (intent.current !== null && intent.current !== committingRequest)) return;
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
  }, [committed, parentRoute, native.sessionId, native.documentGeneration, visible, native.getNavigation, router]);

  useEffect(() => {
    if (mirrored.current === visible) { mirrored.current = null; return; }
    if (mirrored.current !== null) return;
    if (!committed || visible === committed || lastRequested.current === visible || native.status !== 'connected') return;
    // An OS deep link or an external Router action requests a core transition once.
    void navigate(visible, true).catch(() => {});
  }, [visible, committed, native.status, navigate]);
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack) { BackHandler.exitApp(); return true; }
      void back().catch(() => {});
      return true;
    });
    return () => listener.remove();
  }, [back, canGoBack]);

  const value = useMemo(() => ({ live, draftStore, endpoint, setEndpoint, coherent: committed === visible, canGoBack }), [live, draftStore, endpoint, setEndpoint, committed, visible, canGoBack]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useChecklistNavigation() {
  const context = useContext(Context);
  if (!context) throw new Error('ChecklistNavigationProvider is missing');
  return context;
}
