import React, { useEffect, useRef, useState } from 'react';
import { type ScrollViewInstance, ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { LiveView } from '@liveview-native/react-native';
import { OfflineChecklist } from './OfflineChecklist';
import { CommandsPanel } from './CommandsPanel';
import { pickUpload } from './pickUpload';
import { useChecklistNavigation } from './navigation';
import { useIsFocused } from 'expo-router/react-navigation';

import { useObserve } from 'expo-observe';
import { useTelemetry } from './telemetry';
import { measure } from '@liveview-native/react-native';

function LiveScreen() {
  const { live, coherent, draftStore, offline, cached, repositoryError } = useChecklistNavigation();
  const [account, setAccount] = useState('workshop');
  const [password, setPassword] = useState('');
  const metadata = [...(live.document?.nodes.values() ?? [])].find(node => node.attributes?.['data-auth']);
  const signedOut = coherent && metadata?.attributes?.['data-auth'] === 'signed-out';
  const connectedAccount = [...(live.document?.nodes.values() ?? [])].find(node => node.attributes?.['data-account'])?.attributes?.['data-account'];
  const activeAccount = offline ? cached.account : connectedAccount;
  const authenticated = useRef<string | null>(null);
  useEffect(() => {
    if (!offline && activeAccount && authenticated.current !== activeAccount) { measure('auth.login'); setPassword(''); }
    authenticated.current = activeAccount ?? null;
  }, [activeAccount, offline]);
  const { markInteractive } = useObserve();
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (coherent && live.document && live.status === 'connected' && marked.current !== `${live.sessionId}:${live.documentGeneration}`) {
      marked.current = `${live.sessionId}:${live.documentGeneration}`; markInteractive();
    }
  }, [coherent, live.document, live.status, live.sessionId, live.documentGeneration, markInteractive]);
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
      {live.error && <Text testID="connection-error" style={styles.error}>{offline ? 'Can’t reach the server. Cached tasks and local drafts are available below.' : live.error}</Text>}
      {signedOut && <View style={styles.endpointPanel}>
        <Text style={styles.label}>DEMO ACCOUNT</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {['workshop', 'studio'].map(value => <Pressable key={value} testID={`account-${value}`} style={styles.connect} onPress={() => setAccount(value)}>
            <Text style={styles.connectText}>{account === value ? '● ' : ''}{value}</Text>
          </Pressable>)}
        </View>
        <TextInput testID="password" accessibilityLabel="Password" secureTextEntry value={password} onChangeText={setPassword} style={styles.input} autoCapitalize="none" />
        <Text style={styles.hint}>Demo password: {account}-demo</Text>
        <Pressable testID="sign-in" accessibilityRole="button" style={styles.connect} onPress={() => {
          void live.postForm('/session', { account, password }).catch(() => {});
        }}><Text style={styles.connectText}>Sign in</Text></Pressable>
      </View>}
      {activeAccount && <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between'}}>
        <Text style={styles.hint}>{activeAccount}</Text>
        <Pressable testID="sign-out" accessibilityRole="button" style={styles.connect} onPress={() => { setPassword(''); void live.logout('/session/delete').catch(() => {}); }}>
          <Text style={styles.connectText}>Sign out</Text>
        </Pressable>
      </View>}
      {repositoryError && <Text testID="offline-storage-error" style={styles.error}>Device cache: {repositoryError}</Text>}
      <View style={styles.live}>
        {offline ? <OfflineChecklist /> : <LiveView pickUpload={pickUpload} draftStore={draftStore} session={coherent ? live : { ...live, document: null }} loading={
          <View style={styles.loading}>
            <ActivityIndicator color="#d8ebae" />
            <Text style={styles.hint}>Waiting for Phoenix LiveView…</Text>
          </View>
        } />}
      </View>
      <CommandsPanel />
    </>
  );
}

function App() {
  const focused = useIsFocused();
  const scroll = useRef<ScrollViewInstance>(null);
  useEffect(() => {
    if (!__DEV__ || !focused) return;
    const debug = globalThis as unknown as { __lvnScrollTo?: (y: number) => void; __lvnScrollEnd?: () => void };
    const scrollTo = (y: number) => { if (Number.isFinite(y)) scroll.current?.scrollTo({ y: Math.max(0, y), animated: false }); };
    const scrollEnd = () => scroll.current?.scrollToEnd({ animated: false });
    debug.__lvnScrollTo = scrollTo; debug.__lvnScrollEnd = scrollEnd;
    return () => {
      if (debug.__lvnScrollTo === scrollTo) delete debug.__lvnScrollTo;
      if (debug.__lvnScrollEnd === scrollEnd) delete debug.__lvnScrollEnd;
    };
  }, [focused]);
  const { endpoint: url, setEndpoint: setUrl } = useChecklistNavigation();
  const telemetry = useTelemetry();
  const latest = [...telemetry].reverse().find(event => event.name === 'lvn.document.received');
  const [draftUrl, setDraftUrl] = useState(url);
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
  if (!focused) return <View style={styles.app} />;
  return (
    <KeyboardAvoidingView style={styles.app} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar barStyle="light-content" />
      <ScrollView ref={scroll} contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <View style={styles.mark}><Text style={styles.markText}>LV</Text></View>
          <View><Text style={styles.brand}>LIVEVIEW NATIVE</Text><Text style={styles.edition}>React Native · Expo 58 beta</Text></View>
          <View style={styles.badge}><Text style={styles.badgeText}>CHECKLIST</Text></View>
        </View>
        <LiveScreen />
        {__DEV__ && <Text testID="telemetry" style={styles.hint}>Telemetry · {latest?.attributes.nodes ?? 0} nodes · {latest?.attributes.bridgeBytes ?? latest?.attributes.snapshotBytes ?? 0} bytes ({latest?.attributes.kind ?? 'full'}) · parse {Number(latest?.attributes.parseMs ?? 0).toFixed(2)} ms</Text>}
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
          <Text style={styles.hint}>Tasks are persisted by Phoenix. Server updates render through Rust core.</Text>
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

export default App;
