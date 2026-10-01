import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { nativeTransport } from './native';
import { LiveViewStore } from './store';
import type { LiveViewSession } from './types';

export function useLiveView({ url, suspendInBackground = true }: { url: string; suspendInBackground?: boolean }): LiveViewSession {
  const store = useMemo(() => new LiveViewStore(nativeTransport(), url), [url]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      if (state === 'background' && suspendInBackground) store.stop('background');
      if (state === 'active') store.start();
    });
    if (AppState.currentState !== 'background') store.start();
    return () => { listener.remove(); store.stop('unmount'); };
  }, [store, suspendInBackground]);
  return useMemo(() => ({ ...snapshot, pushEvent: store.pushEvent, sendForm: store.sendForm, retry: store.retry, postForm: store.postForm, logout: store.logout, navigate: store.navigate, back: store.back, forward: store.forward, getNavigation: store.getNavigation }), [snapshot, store]);
}
