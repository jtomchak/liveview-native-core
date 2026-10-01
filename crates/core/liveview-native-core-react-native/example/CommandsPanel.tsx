import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useChecklistNavigation } from './navigation';

const styles = StyleSheet.create({
  panel: { gap: 12 }, card: { gap: 10, padding: 16, borderWidth: 1, borderColor: '#455343', borderRadius: 12, backgroundColor: '#1d2924' },
  title: { color: '#f6f4eb', fontSize: 18, fontWeight: '700' }, body: { color: '#a4b2a9', fontSize: 13, lineHeight: 20 },
  label: { color: '#e7c78d', fontWeight: '600', fontSize: 13 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  button: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 9, backgroundColor: '#2c3c2d' },
  buttonText: { color: '#d6e5c7', fontSize: 12, fontWeight: '600' }, disabled: { opacity: 0.4 },
});
const reviewLabels = {
  expired: 'The action expired. Review the latest task before reapplying.',
  unauthorized: 'Sign in and verify access before creating another change.',
  quota: 'The server action limit was reached. Your intended change is kept.',
  invalid: 'The server could not accept these fields. Discard the action and edit the draft.',
  id_reused: 'The server could not verify this action. Discard it and review the task.',
  not_found: 'This task is no longer available on the server.',
};

/** Displays typed durable commands, never a replay of arbitrary LiveView events. */
export function CommandsPanel() {
  const { repository, cached, verifiedAccount } = useChecklistNavigation();
  const commands = useSyncExternalStore(repository.subscribeCommands, repository.getCommands, repository.getCommands);
  const [error, setError] = useState<string | null>(null);
  const reapplyHandlers = new Map<string, () => void>();
  useEffect(() => {
    if (!__DEV__) return;
    const debug = globalThis as unknown as { __lvnReapplyCommands?: Map<string, () => void> };
    const actions = debug.__lvnReapplyCommands ??= new Map();
    for (const [id, handler] of reapplyHandlers) actions.set(id, handler);
    return () => { for (const [id, handler] of reapplyHandlers) if (actions.get(id) === handler) actions.delete(id); };
  }, [reapplyHandlers]);
  if (!commands.length) return null;
  return <View style={styles.panel} testID="commands-panel">
    <Text style={styles.title}>Pending changes · {commands.length}</Text>
    <Text style={styles.body}>Queued changes sync after your account is verified. Conflicts keep your intended changes for review.</Text>
    {commands.map(pending => {
      const { command } = pending;
      const task = cached.records.flatMap(checklist => checklist.tasks).find(item => item.id === command.taskId);
      const reapplicable = pending.state === 'conflict' || (pending.state === 'review' && pending.reason === 'expired');
      const canReapply = reapplicable && verifiedAccount === command.accountId && task !== undefined &&
        (pending.state !== 'conflict' || (pending.currentVersion !== undefined && task.version >= pending.currentVersion));
      const act = (operation: () => void) => { try { operation(); setError(null); } catch { setError('Device storage failed. The pending change was kept.'); } };
      const reapply = () => { if (canReapply) act(() => repository.reapplyCommand(command.operationId, task!.version)); };
      if (canReapply) reapplyHandlers.set(command.operationId, reapply);
      return <View key={command.operationId} style={styles.card} testID={`command-${pending.state}`}>
        <Text style={styles.label}>{pending.state === 'queued' ? 'Queued' : pending.state === 'conflict' ? 'Conflict · task changed on the server' : 'Review required'}</Text>
        <Text style={styles.title}>{task?.title ?? 'Task no longer in the confirmed cache'}</Text>
        <Text style={styles.body}>Your intended status: {command.payload.completed ? 'Completed' : 'Incomplete'}</Text>
        {command.type === 'update_task' && <><Text style={styles.body}>Your intended title: {command.payload.title}</Text><Text style={styles.body}>Your intended notes: {command.payload.notes || 'No notes.'}</Text></>}
        {pending.state !== 'queued' && task && <>
          <Text style={styles.body}>Confirmed server values · version {task.version}</Text>
          <Text style={styles.body}>{task.title} · {task.completed ? 'Completed' : 'Incomplete'}</Text>
          <Text style={styles.body}>{task.notes || 'No notes.'}</Text>
        </>}
        {pending.state === 'review' && <Text style={styles.body}>{pending.reason ? reviewLabels[pending.reason] : 'This change needs a new decision. Discard it and review the task before creating another change.'}</Text>}
        <View style={styles.actions}>
          <Pressable testID="discard-command" accessibilityRole="button" style={styles.button} onPress={() => act(() => repository.discardCommand(command.operationId))}><Text style={styles.buttonText}>Discard queued change</Text></Pressable>
          {reapplicable && <Pressable testID="reapply-command" accessibilityRole="button" disabled={!canReapply} style={[styles.button, !canReapply && styles.disabled]} onPress={reapply}><Text style={styles.buttonText}>Reapply to current version</Text></Pressable>}
        </View>
        {reapplicable && !canReapply && <Text style={styles.body}>Connect and refresh this task before reapplying.</Text>}
        <Text style={styles.body}>Discarding a queued change keeps any local draft.</Text>
      </View>;
    })}
    {error && <Text testID="commands-error" style={styles.label}>{error}</Text>}
  </View>;
}
