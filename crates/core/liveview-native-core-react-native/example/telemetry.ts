import { useSyncExternalStore } from 'react';
import { DiagnosticBuffer } from './diagnostics';
import { Observe } from 'expo-observe';
import { setTelemetrySink, type TelemetryEvent } from '@liveview-native/react-native';
Observe.configure({ environment: __DEV__ ? 'development' : 'production', dispatchInDebug: true });
const buffer = new DiagnosticBuffer();
const listeners = new Set<() => void>();
setTelemetrySink(event => {
  Observe.logEvent(event.name, { attributes: event.attributes });
  // Updating a useSyncExternalStore snapshot during a Profiler commit causes
  // React's post-commit consistency check to schedule another render forever.
  if (!buffer.record(event)) return;
  listeners.forEach(listener => listener());
});
export const getTelemetry = buffer.getSnapshot;
export function useTelemetry() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getTelemetry, getTelemetry);
}
if (__DEV__) (globalThis as any).__lvnTelemetry = getTelemetry;
