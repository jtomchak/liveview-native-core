import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { FormController, type FormDraftStore, type FormState } from './formEvents';
import type { LiveViewDocument, LiveViewNode, LiveViewSession } from './types';

type Attributes = Readonly<Record<string, string | null>>;
const emptyState: FormState = Object.freeze({ fields: {}, sequence: 0, dirty: false, submitting: false, errors: {}, error: null });
const noopSubscribe = () => () => {};
const emptySnapshot = () => emptyState;
const Context = createContext<FormController | null>(null);
const styles = StyleSheet.create({
  form: { gap: 15 }, input: { color: '#f6f4eb', backgroundColor: '#1c2821', borderWidth: 1, borderColor: '#455343', borderRadius: 10, padding: 12, fontSize: 16 },
  button: { backgroundColor: '#e3f1b0', borderRadius: 13, paddingVertical: 13, paddingHorizontal: 20, alignSelf: 'flex-start' },
  error: { color: '#ffb4a9', fontSize: 13, lineHeight: 20 }, hint: { color: '#a4b2a9', fontSize: 12 }, disabled: { opacity: 0.45 },
});
export function formFields(document: LiveViewDocument, node: LiveViewNode) {
  const fields: Record<string, string> = {};
  function visit(id: number) {
    const child = document.nodes.get(id);
    if (!child) return;
    if (child.tag === 'Form') return;
    const name = child.attributes?.name;
    if (name && ['TextInput', 'Switch', 'HiddenInput'].includes(child.tag ?? '')) {
      Object.defineProperty(fields, name, { value: child.attributes?.value ?? '', writable: true, enumerable: true, configurable: true });
    }
    child.children.forEach(visit);
  }
  node.children.forEach(visit);
  return fields;
}
function metadataErrors(value: string | null | undefined): Readonly<Record<string, string>> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}
export function FormView({ attributes, fields, session, draftStore, children }: {
  attributes: Attributes; fields: Readonly<Record<string, string>>; session: LiveViewSession; draftStore: FormDraftStore; children: ReactNode;
}) {
  const key = attributes['data-form-key'] ?? attributes.id ?? 'form';
  const cid = attributes['phx-target'] && /^\d+$/.test(attributes['phx-target']) ? Number(attributes['phx-target']) : undefined;
  const debounceValue = Number(attributes['phx-debounce'] ?? 250);
  const debounce = Number.isFinite(debounceValue) ? Math.min(2000, Math.max(0, debounceValue)) : 250;
  const controller = useMemo(() => new FormController(key, fields, draftStore, session.sendForm,
    attributes['phx-change'] ?? null, attributes['phx-submit'] ?? null, debounce, cid,
    attributes['data-saved-route'] ? () => session.navigate(attributes['data-saved-route']!, true) : undefined,
    () => session.navigate('/sign-in', true)),
  [key, draftStore, session.sessionId, session.documentGeneration, session.sendForm, session.navigate, attributes['data-saved-route']]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  useEffect(() => {
    if (!__DEV__) return;
    const debug = globalThis as unknown as { __lvnForms?: Map<string, FormController> };
    const forms = debug.__lvnForms ??= new Map();
    forms.set(key, controller);
    return () => { if (forms.get(key) === controller) forms.delete(key); };
  }, [controller, key]);
  useEffect(() => {
    controller.updateServer(fields, Number(attributes['data-validated-seq'] ?? 0), metadataErrors(attributes['data-form-errors']), attributes['data-form-status'] ?? undefined);
  }, [controller, fields, attributes]);
  return <Context.Provider value={controller}>
    <View testID={attributes.testID ?? attributes.id ?? undefined} style={styles.form}>
      {state.dirty && <Text testID="form-draft" style={styles.hint}>Unsaved draft</Text>}
      {children}
      {Object.entries(state.errors).map(([name, message]) => <Text key={name} testID={`error-${name}`} style={styles.error}>{message}</Text>)}
      {state.error && <Text testID="form-error" style={styles.error}>{state.error}</Text>}
    </View>
  </Context.Provider>;
}
function useField(attributes: Attributes) {
  const controller = useContext(Context);
  const state = useSyncExternalStore(controller?.subscribe ?? noopSubscribe, controller?.getSnapshot ?? emptySnapshot, controller?.getSnapshot ?? emptySnapshot);
  const name = attributes.name ?? '';
  return { controller, state, name, value: state.fields[name] ?? '' };
}
export function FormTextInput({ attributes, connected }: { attributes: Attributes; connected: boolean }) {
  const { controller, state, name, value } = useField(attributes);
  if (!controller) return <Text style={styles.error}>TextInput requires an installed Form.</Text>;
  const multiline = attributes.multiline === 'true';
  const limit = Number(attributes.maxLength);
  return <TextInput testID={attributes.testID ?? attributes.id ?? name} accessibilityLabel={attributes.accessibilityLabel ?? name}
    value={value} onChangeText={text => controller.setField(name, text)} editable={connected && !state.submitting && attributes.disabled !== 'true'}
    multiline={multiline} numberOfLines={multiline ? 4 : 1} textAlignVertical={multiline ? 'top' : 'center'}
    secureTextEntry={attributes.secureTextEntry === 'true'} placeholder={attributes.placeholder ?? undefined} placeholderTextColor="#819488"
    maxLength={Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : undefined}
    style={[styles.input, multiline && { minHeight: 100 }]} />;
}
export function FormSwitch({ attributes, connected }: { attributes: Attributes; connected: boolean }) {
  const { controller, state, name, value } = useField(attributes);
  if (!controller) return <Text style={styles.error}>Switch requires an installed Form.</Text>;
  return <Switch testID={attributes.testID ?? attributes.id ?? name} accessibilityLabel={attributes.accessibilityLabel ?? name}
    value={value === 'true'} disabled={!connected || state.submitting || attributes.disabled === 'true'}
    onValueChange={checked => controller.setField(name, String(checked))} trackColor={{ false: '#455343', true: '#a8d3aa' }} />;
}
export function FormButton({ attributes, session, children }: { attributes: Attributes; session: LiveViewSession; children: ReactNode }) {
  const controller = useContext(Context);
  const state = useSyncExternalStore(controller?.subscribe ?? noopSubscribe, controller?.getSnapshot ?? emptySnapshot, controller?.getSnapshot ?? emptySnapshot);
  if (!controller) return <Text style={styles.error}>FormButton requires an installed Form.</Text>;
  const disabled = session.status !== 'connected' || state.submitting || attributes.disabled === 'true';
  return <Pressable testID={attributes.testID ?? attributes.id ?? undefined} accessibilityLabel={attributes.accessibilityLabel ?? undefined}
    accessibilityRole="button" disabled={disabled} style={[styles.button, disabled && styles.disabled]}
    onPress={() => { void controller.submit(session.status === 'connected'); }}>{children}</Pressable>;
}
export function FormCancel({ attributes, session, draftStore, children }: { attributes: Attributes; session: LiveViewSession; draftStore: FormDraftStore; children: ReactNode }) {
  const controller = useContext(Context);
  const state = useSyncExternalStore(controller?.subscribe ?? noopSubscribe, controller?.getSnapshot ?? emptySnapshot, controller?.getSnapshot ?? emptySnapshot);
  const disabled = session.status !== 'connected' || state?.submitting === true;
  return <Pressable testID={attributes.testID ?? attributes.id ?? undefined} accessibilityRole="button" disabled={disabled}
    style={[styles.button, disabled && styles.disabled]} onPress={() => {
      if (controller && !controller.cancel()) return;
      const key = attributes['data-cancel-form-key']; if (key) draftStore.delete(key);
      const target = attributes['data-navigate'];
      if (target) void session.navigate(target, attributes['data-nav-action'] === 'replace').catch(() => {});
    }}>{children}</Pressable>;
}
