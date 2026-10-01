import React, { useEffect, useMemo, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { UploadController, type PickUpload } from './uploadController';
import type { LiveViewSession } from './types';

const styles = StyleSheet.create({
  panel: { gap: 10, paddingVertical: 14 }, button: { alignSelf: 'flex-start', backgroundColor: '#e3f1b0', borderRadius: 13, paddingHorizontal: 20, paddingVertical: 13 },
  label: { color: '#20311d', fontSize: 15, fontWeight: '700' }, caption: { color: '#a4b2a9', fontSize: 13, lineHeight: 20 }, error: { color: '#ffb4a9', fontSize: 13, lineHeight: 20 }, disabled: { opacity: 0.45 },
});
function uploadErrors(value: string | null | undefined) {
  if (!value) return [];
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((error): error is string => typeof error === 'string').slice(0, 10) : []; }
  catch { return []; }
}
export function UploadInput({ attributes, session, pickUpload }: {
  attributes: Readonly<Record<string, string | null>>; session: LiveViewSession; pickUpload?: PickUpload;
}) {
  const fieldName = attributes.name ?? '';
  const controller = useMemo(() => new UploadController(pickUpload, asset => session.uploadFile(fieldName, asset)),
    [pickUpload, session.uploadFile, fieldName, session.sessionId, session.documentGeneration]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  useEffect(() => {
    const value = attributes['data-upload-progress'];
    controller.updateServer(attributes['data-upload-status'] ?? 'idle', attributes['data-upload-ref'] || null,
      value !== null && value !== undefined && value !== '' ? Number(value) : null, uploadErrors(attributes['data-upload-errors']));
  }, [controller, attributes]);
  useEffect(() => {
    if (!__DEV__) return;
    const debug = globalThis as unknown as { __lvnUploads?: Map<string, UploadController> };
    const uploads = debug.__lvnUploads ??= new Map(); uploads.set(fieldName, controller);
    return () => { if (uploads.get(fieldName) === controller) uploads.delete(fieldName); };
  }, [controller, fieldName]);
  const blocked = session.status !== 'connected' || state.busy || (state.phase === 'error' && state.entryRef !== null) || ['ready', 'awaiting', 'uploading'].includes(state.phase);
  return <View testID={attributes.testID ?? attributes.id ?? 'upload-input'} style={styles.panel}>
    <Pressable testID="choose-attachment" accessibilityRole="button" accessibilityLabel="Choose attachment" disabled={blocked}
      style={[styles.button, blocked && styles.disabled]} onPress={() => { void controller.select(session.status === 'connected'); }}>
      <Text style={styles.label}>{state.phase === 'error' ? 'Choose file again' : 'Choose attachment'}</Text>
    </Pressable>
    <Text style={styles.caption}>PNG or text · up to 2 MiB</Text>
    {state.asset && <Text testID="selected-attachment" style={styles.caption}>{state.asset.name} · {state.asset.mimeType}{state.asset.size !== undefined ? ` · ${state.asset.size} bytes` : ''}</Text>}
    {state.busy && <ActivityIndicator color="#d8ebae" />}
    {state.progress !== null && <Text testID="upload-progress" style={styles.caption}>Server received: {state.progress}%</Text>}
    {state.phase === 'awaiting' && <Text style={styles.caption}>Waiting for the server to confirm the transfer…</Text>}
    {state.phase === 'ready' && <Text testID="upload-ready" style={styles.caption}>Transfer complete. Save attachment to persist it.</Text>}
    {state.phase === 'saved' && <Text testID="upload-saved" style={styles.caption}>Attachment saved.</Text>}
    {state.phase === 'cancelled' && <Text testID="upload-cancelled" style={styles.caption}>Upload cancelled. No attachment was saved.</Text>}
    {state.phase === 'error' && state.entryRef !== null && <Text style={styles.caption}>Cancel the pending entry before choosing another file.</Text>}
    {state.error && <Text testID="upload-error" style={styles.error}>{state.error}</Text>}
  </View>;
}
