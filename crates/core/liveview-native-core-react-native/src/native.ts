import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { selectNativeTransport } from './nativeSelection';
import type { LiveViewTransport } from './types';

export function nativeTransport(): LiveViewTransport {
  // This also installs Expo's native host objects before inspecting expoV2.
  const classic = requireOptionalNativeModule<LiveViewTransport>('LiveViewNative');
  const v2 = (globalThis as typeof globalThis & {
    expoV2?: { modules?: { LiveViewNative?: LiveViewTransport } };
  }).expoV2;
  const native = selectNativeTransport(Platform.OS, classic, v2);
  if (!native) {
    const error = () => new Error(
      'LiveViewNative requires the custom iOS or Android Expo Modules 2.0 development build. ' +
      'Build the Rust bindings, then run expo run:ios or expo run:android. Expo Go and web do not include this module.',
    );
    return {
      connect: async () => { throw error(); },
      sendEvent: async () => { throw error(); },
      disconnect: async () => {},
      addListener: () => ({ remove() {} }),
    };
  }
  return native;
}
