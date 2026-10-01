import React, { memo, Profiler, useMemo, type ComponentType, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { measure } from './telemetry';
import { UploadInput } from './Uploads';
import type { PickUpload } from './uploadController';
import { FormView, FormTextInput, FormSwitch, FormButton, FormCancel, formFields } from './Forms';
import { MemoryFormDraftStore, type FormDraftStore } from './formEvents';
import { clickEvent } from './events';
import type { LiveViewDocument, LiveViewNode, LiveViewSession } from './types';

export type LiveViewComponentProps = {
  node: LiveViewNode;
  attributes: Readonly<Record<string, string | null>>;
  children: ReactNode;
  pushEvent: LiveViewSession['pushEvent'];
};
export type LiveViewComponents = Readonly<Record<string, ComponentType<LiveViewComponentProps>>>;
const emptyComponents: LiveViewComponents = Object.freeze({});
let renderCountScope: string | null = null;
let nodeRenderCounts: Map<number, number> | null = null;
function recordNodeRender(id: number, session: LiveViewSession) {
  if (!__DEV__) return;
  const scope = `${session.sessionId}:${session.documentGeneration}`;
  if (scope !== renderCountScope || nodeRenderCounts === null) {
    renderCountScope = scope; nodeRenderCounts = new Map();
    (globalThis as unknown as { __lvnNodeRenderCounts?: ReadonlyMap<number, number> }).__lvnNodeRenderCounts = nodeRenderCounts;
  }
  if (nodeRenderCounts.has(id) || nodeRenderCounts.size < 5000) nodeRenderCounts.set(id, (nodeRenderCounts.get(id) ?? 0) + 1);
}

const viewStyles = StyleSheet.create({
  screen: { gap: 18 },
  task: { gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderColor: '#344538' },
  card: { borderRadius: 24, backgroundColor: '#1d2924', padding: 25, gap: 18, borderWidth: 1, borderColor: '#32443a' },
  actions: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  button: { backgroundColor: '#e3f1b0', borderRadius: 13, paddingVertical: 13, paddingHorizontal: 20, minWidth: 54, alignItems: 'center' },
});
const textStyles = StyleSheet.create({
  taskTitle: { color: '#f6f4eb', fontSize: 19, fontWeight: '600' },
  eyebrow: { color: '#a8d3aa', fontSize: 11, fontWeight: '700', letterSpacing: 2.5 },
  title: { color: '#f6f4eb', fontSize: 35, fontWeight: '700', letterSpacing: -1.4 },
  subtitle: { color: '#a4aaa7', fontSize: 15, lineHeight: 23, maxWidth: 320 },
  caption: { color: '#a4b2a9', fontSize: 12, lineHeight: 19 },
  heartbeat: { color: '#a4b2a9', fontSize: 12, lineHeight: 19, fontVariant: ['tabular-nums'] },
  counter: { color: '#e3f1b0', fontSize: 82, fontWeight: '600', letterSpacing: -5, fontVariant: ['tabular-nums'] },
  buttonLabel: { color: '#20311d', fontWeight: '700', fontSize: 15 },
  unsupported: { color: '#ffb4a9', fontSize: 12, lineHeight: 18 },
});

type NodeRendererProps = {
  document: LiveViewDocument;
  id: number;
  session: LiveViewSession;
  components: LiveViewComponents;
  draftStore: FormDraftStore;
  pickUpload?: PickUpload;
  insideText?: boolean;
};

function sameRenderedSubtree(previous: NodeRendererProps, next: NodeRendererProps): boolean {
  if (previous.id !== next.id || previous.insideText !== next.insideText || previous.components !== next.components ||
    previous.draftStore !== next.draftStore || previous.pickUpload !== next.pickUpload) return false;
  const oldSession = previous.session, session = next.session;
  // Revision and document identity change for every patch. Only capabilities
  // consumed by installed components invalidate an otherwise unchanged branch.
  if (oldSession.sessionId !== session.sessionId || oldSession.documentGeneration !== session.documentGeneration ||
    oldSession.status !== session.status || oldSession.pushEvent !== session.pushEvent || oldSession.navigate !== session.navigate ||
    oldSession.cancelUpload !== session.cancelUpload || oldSession.uploadFile !== session.uploadFile || oldSession.sendForm !== session.sendForm) return false;
  if (previous.document === next.document) return true;
  const before = previous.document.subtreeVersions?.get(previous.id);
  const after = next.document.subtreeVersions?.get(next.id);
  // Externally constructed documents without versions retain the full-render
  // behavior. Node identity also protects independent snapshots with equal counters.
  return before !== undefined && after !== undefined && before === after &&
    previous.document.nodes.get(previous.id) === next.document.nodes.get(next.id);
}

function NodeRenderer({ document, id, session, components, draftStore, pickUpload, insideText = false }: NodeRendererProps): ReactNode {
  recordNodeRender(id, session);
  const node = document.nodes.get(id)!;
  if (node.kind === 'text') {
    if (insideText) return node.text;
    return node.text?.trim() ? <Text key={id}>{node.text}</Text> : null;
  }
  const attributes = node.attributes ?? {};
  // The native root layout includes metadata consumed by core during connection.
  if (node.tag === 'csrf-token') return null;
  const children = node.children.map(child => <MemoNode key={child} document={document} id={child} session={session}
    components={components} draftStore={draftStore} pickUpload={pickUpload} insideText={node.tag === 'Text'} />);
  if (node.kind === 'root') return <React.Fragment key={`${session.sessionId}:${session.documentGeneration}`}>{children}</React.Fragment>;
  const Custom = Object.hasOwn(components, node.tag!) ? components[node.tag!] : undefined;
  if (Custom) {
    return <Custom key={id} node={node} attributes={attributes} pushEvent={session.pushEvent}>{children}</Custom>;
  }
  const token = attributes['data-style'];
  const viewStyle = token && Object.hasOwn(viewStyles, token) ? viewStyles[token as keyof typeof viewStyles] : undefined;
  const textStyle = token && Object.hasOwn(textStyles, token) ? textStyles[token as keyof typeof textStyles] : undefined;
  // Server attributes never become an unrestricted native prop bag or executable code.
  const props = {
    testID: attributes.testID ?? attributes.id ?? undefined,
    accessibilityLabel: attributes.accessibilityLabel ?? undefined,
  };
  switch (node.tag) {
    case 'UploadInput': return <UploadInput key={attributes.name ?? id} attributes={attributes} session={session} pickUpload={pickUpload} />;
    case 'Form': return <FormView key={attributes['data-form-key'] ?? id} attributes={attributes} fields={formFields(document, node)} session={session} draftStore={draftStore}>{children}</FormView>;
    case 'TextInput': return <FormTextInput key={attributes.name ?? id} attributes={attributes} connected={session.status === 'connected'} />;
    case 'Switch': return <FormSwitch key={attributes.name ?? id} attributes={attributes} connected={session.status === 'connected'} />;
    case 'HiddenInput': return null;
    case 'FormButton': return <FormButton key={id} attributes={attributes} session={session}>{children}</FormButton>;
    case 'View': return <View key={id} {...props} style={viewStyle}>{children}</View>;
    case 'Text': return <Text key={id} {...props} style={textStyle}>{children}</Text>;
    case 'Pressable': {
      if (attributes['data-form-cancel'] === 'true' || attributes['data-cancel-form-key']) return <FormCancel key={id} attributes={attributes} session={session} draftStore={draftStore}>{children}</FormCancel>;
      const click = clickEvent(attributes);
      const navigate = attributes['data-navigate'];
      const cancelUploadField = attributes['data-cancel-upload-field'];
      const cancelUploadRef = attributes['phx-value-ref'];
      const disabled = session.status.toLowerCase() !== 'connected' ||
        (attributes.disabled !== undefined && attributes.disabled !== 'false');
      return (
        <Pressable key={id} {...props} style={viewStyle} disabled={disabled} accessibilityRole="button"
          onPress={cancelUploadField && cancelUploadRef ? () => { void session.cancelUpload(cancelUploadField, cancelUploadRef).catch(() => {}); } : navigate ? () => { void session.navigate(navigate, attributes['data-nav-action'] === 'replace').catch(() => {}); } : click ? () => { void session.pushEvent(click.event, click.value).catch(() => {}); } : undefined}>
          {children}
        </Pressable>
      );
    }
    default: return <Text key={id} style={textStyles.unsupported}>Unknown installed component: {node.tag}</Text>;
  }
}
const MemoNode = memo(NodeRenderer, sameRenderedSubtree);

export function LiveView({ session, components = emptyComponents, loading = null, draftStore: providedDraftStore, pickUpload }: {
  session: LiveViewSession;
  components?: LiveViewComponents;
  loading?: ReactNode;
  draftStore?: FormDraftStore;
  pickUpload?: PickUpload;
}) {
  const localDraftStore = useMemo(() => new MemoryFormDraftStore(), []);
  const draftStore = providedDraftStore ?? localDraftStore;
  return <Profiler id="LiveView" onRender={(_, phase, actualDuration) => measure('react.commit', { phase, durationMs: actualDuration })}>
    {session.document ? <MemoNode document={session.document} id={session.document.root} session={session} components={components}
      draftStore={draftStore} pickUpload={pickUpload} /> : loading}
  </Profiler>;
}
