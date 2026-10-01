import React, { Profiler, type ComponentType, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { measure } from './telemetry';
import { clickEvent } from './events';
import type { LiveViewDocument, LiveViewNode, LiveViewSession } from './types';

export type LiveViewComponentProps = {
  node: LiveViewNode;
  attributes: Readonly<Record<string, string | null>>;
  children: ReactNode;
  pushEvent: LiveViewSession['pushEvent'];
};
export type LiveViewComponents = Readonly<Record<string, ComponentType<LiveViewComponentProps>>>;

const viewStyles = StyleSheet.create({
  screen: { gap: 18 },
  card: { borderRadius: 24, backgroundColor: '#1d2924', padding: 25, gap: 18, borderWidth: 1, borderColor: '#32443a' },
  actions: { flexDirection: 'row', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  button: { backgroundColor: '#e3f1b0', borderRadius: 13, paddingVertical: 13, paddingHorizontal: 20, minWidth: 54, alignItems: 'center' },
});
const textStyles = StyleSheet.create({
  eyebrow: { color: '#a8d3aa', fontSize: 11, fontWeight: '700', letterSpacing: 2.5 },
  title: { color: '#f6f4eb', fontSize: 35, fontWeight: '700', letterSpacing: -1.4 },
  subtitle: { color: '#a4aaa7', fontSize: 15, lineHeight: 23, maxWidth: 320 },
  caption: { color: '#a4b2a9', fontSize: 12, lineHeight: 19 },
  heartbeat: { color: '#a4b2a9', fontSize: 12, lineHeight: 19, fontVariant: ['tabular-nums'] },
  counter: { color: '#e3f1b0', fontSize: 82, fontWeight: '600', letterSpacing: -5, fontVariant: ['tabular-nums'] },
  buttonLabel: { color: '#20311d', fontWeight: '700', fontSize: 15 },
  unsupported: { color: '#ffb4a9', fontSize: 12, lineHeight: 18 },
});

function renderNode(
  document: LiveViewDocument,
  id: number,
  session: LiveViewSession,
  components: LiveViewComponents,
  insideText = false,
): ReactNode {
  const node = document.nodes.get(id)!;
  if (node.kind === 'text') {
    if (insideText) return node.text;
    return node.text?.trim() ? <Text key={id}>{node.text}</Text> : null;
  }
  const attributes = node.attributes ?? {};
  // The native root layout includes metadata consumed by core during connection.
  if (node.tag === 'csrf-token') return null;
  const children = node.children.map(child => renderNode(document, child, session, components, node.tag === 'Text'));
  if (node.kind === 'root') return <React.Fragment key={session.sessionId ?? id}>{children}</React.Fragment>;
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
    case 'View': return <View key={id} {...props} style={viewStyle}>{children}</View>;
    case 'Text': return <Text key={id} {...props} style={textStyle}>{children}</Text>;
    case 'Pressable': {
      const click = clickEvent(attributes);
      const disabled = session.status.toLowerCase() !== 'connected' ||
        (attributes.disabled !== undefined && attributes.disabled !== 'false');
      return (
        <Pressable key={id} {...props} style={viewStyle} disabled={disabled} accessibilityRole="button"
          onPress={click ? () => { void session.pushEvent(click.event, click.value).catch(() => {}); } : undefined}>
          {children}
        </Pressable>
      );
    }
    default: return <Text key={id} style={textStyles.unsupported}>Unknown installed component: {node.tag}</Text>;
  }
}

export function LiveView({ session, components = {}, loading = null }: {
  session: LiveViewSession;
  components?: LiveViewComponents;
  loading?: ReactNode;
}) {
  return <Profiler id="LiveView" onRender={(_, phase, actualDuration) => measure('react.commit', { phase, durationMs: actualDuration })}>
    {session.document ? renderNode(session.document, session.document.root, session, components) : loading}
  </Profiler>;
}
