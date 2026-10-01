import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { LiveView, useLiveView } from '@liveview-native/react-native';

import { ObserveRoot, useObserve } from 'expo-observe';
import { useTelemetry } from './telemetry';

const defaultUrl = Platform.OS === 'android'
  ? 'http://10.0.2.2:4001/react_native'
  : 'http://127.0.0.1:4001/react_native';

function LiveScreen({ url }: { url: string }) {
  const live = useLiveView({ url });
  const { markInteractive } = useObserve();
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (live.document && live.status === 'connected' && marked.current !== live.sessionId) {
      marked.current = live.sessionId; markInteractive();
    }
  }, [live.document, live.status, live.sessionId, markInteractive]);
  const connected = live.status.toLowerCase().includes('connected') && !live.status.toLowerCase().includes('disconnected');
  return (
    <>
      <View style={styles.connection}>
        <View style={[styles.dot, { backgroundColor: connected ? '#c6e797' : '#ddb978' }]} />
        <Text testID="connection-status" style={styles.connectionText}>{live.status}</Text>
        <Text style={styles.revision}>REV {Math.max(0, live.revision)}</Text>
        <Pressable testID="retry" accessibilityRole="button" onPress={live.retry} style={styles.retry}>
          <Text style={styles.retryText}>Reconnect</Text>
        </Pressable>
      </View>
      {live.error && <Text testID="connection-error" style={styles.error}>{live.error}</Text>}
      <View style={styles.live}>
        <LiveView session={live} loading={
          <View style={styles.loading}>
            <ActivityIndicator color="#d8ebae" />
            <Text style={styles.hint}>Waiting for Phoenix LiveView…</Text>
          </View>
        } />
      </View>
    </>
  );
}

function App() {
  const telemetry = useTelemetry();
  const latest = [...telemetry].reverse().find(event => event.name === 'lvn.document.received');
  const [draftUrl, setDraftUrl] = useState(defaultUrl);
  const [url, setUrl] = useState(defaultUrl);
  const [urlError, setUrlError] = useState<string | null>(null);
  function connect() {
    try {
      const parsed = new URL(draftUrl.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Use an http:// or https:// endpoint.');
      setUrl(parsed.toString());
      setUrlError(null);
    } catch (error) {
      setUrlError(error instanceof Error ? error.message : 'Invalid endpoint');
    }
  }
  return (
    <KeyboardAvoidingView style={styles.app} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View style={styles.mark}><Text style={styles.markText}>LV</Text></View>
          <View><Text style={styles.brand}>LIVEVIEW NATIVE</Text><Text style={styles.edition}>React Native · Expo 58 beta</Text></View>
          <View style={styles.badge}><Text style={styles.badgeText}>MVP</Text></View>
        </View>
        <LiveScreen key={url} url={url} />
        {__DEV__ && <Text testID="telemetry" style={styles.hint}>Telemetry · {latest?.attributes.nodes ?? 0} nodes · {latest?.attributes.snapshotBytes ?? 0} bytes · parse {Number(latest?.attributes.parseMs ?? 0).toFixed(2)} ms</Text>}
        <View style={styles.endpointPanel}>
          <Text style={styles.label}>PHOENIX ENDPOINT</Text>
          <TextInput testID="endpoint" style={styles.input} value={draftUrl} onChangeText={setDraftUrl}
            autoCorrect={false} autoCapitalize="none" keyboardType="url" returnKeyType="go"
            onSubmitEditing={connect} accessibilityLabel="Phoenix LiveView endpoint" />
          <Pressable testID="connect-endpoint" style={styles.connect} onPress={connect} accessibilityRole="button">
            <Text style={styles.connectText}>Connect endpoint</Text>
          </Pressable>
          {urlError && <Text style={styles.error}>{urlError}</Text>}
          <Text style={styles.hint}>For a physical device, use your computer’s LAN address.</Text>
        </View>
        <View style={styles.pipeline}>
          <Text style={styles.pipelineText}>PHOENIX → RUST CORE → REACT NATIVE</Text>
          <Text style={styles.hint}>Buttons send LiveView events. The heartbeat arrives from the server once a second.</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: '#101a15' },
  page: { paddingHorizontal: 24, paddingTop: 64, paddingBottom: 44, gap: 22, width: '100%', maxWidth: 560, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 8 },
  mark: { borderRadius: 12, width: 43, height: 43, justifyContent: 'center', alignItems: 'center', backgroundColor: '#d8ebae' },
  markText: { color: '#20311d', fontWeight: '800', fontSize: 16, letterSpacing: -1 },
  brand: { fontSize: 11, color: '#f6f4eb', letterSpacing: 1.5, fontWeight: '700' },
  edition: { fontSize: 11, color: '#9eada2', marginTop: 5 },
  badge: { marginLeft: 'auto', borderWidth: 1, borderColor: '#455343', borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { color: '#b7c1af', fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  connection: { flexDirection: 'row', gap: 7, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3 },
  connectionText: { fontSize: 11, color: '#c9d0c5', textTransform: 'uppercase', letterSpacing: 1 },
  revision: { color: '#738778', fontSize: 10, fontVariant: ['tabular-nums'] },
  retry: { marginLeft: 'auto', padding: 6 },
  retryText: { color: '#c6d7b8', fontSize: 11 },
  error: { color: '#ffb4a9', fontSize: 12, lineHeight: 19 },
  live: { minHeight: 340 },
  loading: { alignItems: 'center', justifyContent: 'center', gap: 20, height: 280 },
  endpointPanel: { borderTopWidth: 1, borderColor: '#2b392f', paddingTop: 21, gap: 12 },
  label: { color: '#83998a', fontSize: 10, letterSpacing: 1.8, fontWeight: '700' },
  input: { backgroundColor: '#1c2821', borderWidth: 1, borderColor: '#344538', borderRadius: 10, color: '#d2dece', fontSize: 12, paddingHorizontal: 12, paddingVertical: 13 },
  connect: { alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 9, backgroundColor: '#2c3c2d' },
  connectText: { color: '#d6e5c7', fontSize: 12, fontWeight: '600' },
  hint: { color: '#819488', fontSize: 11, lineHeight: 18 },
  pipeline: { gap: 8 },
  pipelineText: { color: '#9baf9c', fontSize: 9, letterSpacing: 1.1, fontWeight: '700' },
});

export default ObserveRoot.wrap(App);
