import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { nativeTransport } from './native';
import { LiveViewStore } from './store';
import type { LiveViewSession } from './types';

export function useLiveView({ url }: { url: string }): LiveViewSession {
  const store = useMemo(() => new LiveViewStore(nativeTransport(), url), [url]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      if (state === 'background') store.stop();
      if (state === 'active') store.start();
    });
    if (AppState.currentState !== 'background') store.start();
    return () => { listener.remove(); store.stop(); };
  }, [store]);
  return useMemo(() => ({ ...snapshot, pushEvent: store.pushEvent, retry: store.retry }), [snapshot, store]);
}
