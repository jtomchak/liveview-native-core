import type { LiveViewTransport } from './types';

type V2Namespace = { modules?: { LiveViewNative?: LiveViewTransport } } | undefined;

/** Android SDK 58 installs its v2 modules in a separate JSI namespace. */
export function selectNativeTransport(
  platform: string,
  classic: LiveViewTransport | null,
  v2: V2Namespace,
): LiveViewTransport | null {
  if (platform === 'web') return null;
  const module = platform === 'android' ? v2?.modules?.LiveViewNative : classic;
  if (!module || !['connect', 'sendForm', 'sendEvent', 'disconnect', 'postForm', 'logout', 'navigate', 'back', 'forward', 'getNavigation', 'addListener'].every(
    name => typeof module[name as keyof LiveViewTransport] === 'function',
  )) return null;
  // Return the host object itself: v2 event methods require it as their receiver.
  return module;
}
