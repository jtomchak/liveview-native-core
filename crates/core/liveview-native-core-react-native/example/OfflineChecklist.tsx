import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { FormController } from '../src/formEvents';
import type { CachedTask } from './offlineRepository';
import { useChecklistNavigation } from './navigation';

const styles = StyleSheet.create({
  screen: { gap: 16 }, title: { color: '#f6f4eb', fontWeight: '700', fontSize: 28 }, body: { color: '#a4b2a9', fontSize: 14, lineHeight: 21 },
  card: { gap: 10, padding: 18, backgroundColor: '#1d2924', borderWidth: 1, borderColor: '#344538', borderRadius: 16 },
  button: { alignSelf: 'flex-start', paddingVertical: 11, paddingHorizontal: 15, backgroundColor: '#d8ebae', borderRadius: 10 },
  buttonText: { color: '#20311d', fontWeight: '700' }, input: { color: '#f6f4eb', backgroundColor: '#1c2821', borderColor: '#455343', borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16 },
  banner: { color: '#e7c78d', fontSize: 13, lineHeight: 20 }, disabled: { opacity: 0.4 },
});
function RouteButton({ title, target, replace = false }: { title: string; target: string; replace?: boolean }) {
  const { live } = useChecklistNavigation();
  return <Pressable style={styles.button} accessibilityRole="button" onPress={() => { void live.navigate(target, replace).catch(() => {}); }}><Text style={styles.buttonText}>{title}</Text></Pressable>;
}
function OfflineEditor({ account, task, taskRoute }: { account: string; task: CachedTask; taskRoute: string }) {
  const { repository, live } = useChecklistNavigation();
  const key = `${account}:${task.id}`;
  const controller = useMemo(() => new FormController(key, {
    'task[id]': task.id, 'task[version]': String(task.version), 'task[title]': task.title,
    'task[notes]': task.notes, 'task[completed]': String(task.completed),
  }, repository, async () => ({ status: 'unknown' }), null, null), [key, repository]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const commands = useSyncExternalStore(repository.subscribeCommands, repository.getCommands, repository.getCommands);
  const pending = commands.some(item => item.command.taskId === task.id);
  const [queueError, setQueueError] = useState(false);
  const valid = Boolean(state.fields['task[title]'].trim()) && state.fields['task[title]'].length <= 120 && state.fields['task[notes]'].length <= 2000;
  const queue = () => {
    if (pending || !state.dirty || state.error || !valid) return;
    try {
      repository.enqueue({ taskId: task.id, expectedVersion: Number(state.fields['task[version]']), type: 'update_task', payload: {
        title: state.fields['task[title]'], notes: state.fields['task[notes]'], completed: state.fields['task[completed]'] === 'true',
      } }, key, state.sequence);
      setQueueError(false);
    } catch { setQueueError(true); }
  };
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  useEffect(() => {
    if (!__DEV__) return;
    const debug = globalThis as unknown as { __lvnOfflineEditors?: Map<string, FormController> };
    const editors = debug.__lvnOfflineEditors ??= new Map(); editors.set(key, controller);
    return () => { if (editors.get(key) === controller) editors.delete(key); };
  }, [key, controller]);
  useEffect(() => {
    if (!__DEV__) return;
    const debug = globalThis as unknown as { __lvnOfflineQueueDrafts?: Map<string, () => void> };
    const queues = debug.__lvnOfflineQueueDrafts ??= new Map(); queues.set(key, queue);
    return () => { if (queues.get(key) === queue) queues.delete(key); };
  }, [key, queue]);
  return <View style={styles.screen} testID="offline-editor">
    <Text style={styles.title}>Edit local draft</Text>
    <Text style={styles.body}>Draft changes are saved on this device. Based on task version {state.fields['task[version]']}.</Text>
    <Text style={styles.body}>Title</Text>
    <TextInput testID="offline-title" accessibilityLabel="Title" maxLength={120} value={state.fields['task[title]']} onChangeText={value => controller.setField('task[title]', value)} style={styles.input} />
    <Text style={styles.body}>Notes</Text>
    <TextInput testID="offline-notes" accessibilityLabel="Notes" maxLength={2000} value={state.fields['task[notes]']} onChangeText={value => controller.setField('task[notes]', value)} multiline style={[styles.input, { minHeight: 100, textAlignVertical: 'top' }]} />
    <Text style={styles.body}>Completed</Text>
    <Switch testID="offline-completed" accessibilityLabel="Completed" value={state.fields['task[completed]'] === 'true'} onValueChange={value => controller.setField('task[completed]', String(value))} />
    {state.dirty && !state.error && <Text testID="offline-draft-saved" style={styles.banner}>Unsaved server changes · local draft saved</Text>}
    {state.error && <Text testID="offline-draft-error" style={styles.banner}>Device storage failed. Draft changes are not confirmed saved.</Text>}
    <Pressable testID="queue-draft" disabled={pending || !state.dirty || Boolean(state.error) || !valid} accessibilityRole="button" onPress={queue} style={[styles.button, (pending || !state.dirty || Boolean(state.error) || !valid) && styles.disabled]}><Text style={styles.buttonText}>Queue changes</Text></Pressable>
    {!valid && <Text style={styles.banner}>Enter a title of up to 120 characters and notes of up to 2,000 characters before queuing.</Text>}
    {pending && <Text style={styles.banner}>A change is queued for this task. You can keep editing the draft; later edits are kept separately until you queue them.</Text>}
    {queueError && <Text testID="queue-draft-error" style={styles.banner}>Could not queue this change. Your local draft is kept. Check pending changes and device storage.</Text>}
    <RouteButton title="Keep draft and return" target={taskRoute} replace />
    <Pressable accessibilityRole="button" style={styles.button} onPress={() => { if (!controller.cancel()) return; void live.navigate(taskRoute, true).catch(() => {}); }}>
      <Text style={styles.buttonText}>Discard draft</Text>
    </Pressable>
    {pending && <Text style={styles.body}>Discarding the draft does not cancel the queued change. Use Pending changes to discard that action.</Text>}
  </View>;
}
export function OfflineChecklist() {
  const { cached, visiblePath, live, repository } = useChecklistNavigation();
  const commands = useSyncExternalStore(repository.subscribeCommands, repository.getCommands, repository.getCommands);
  const [queueError, setQueueError] = useState(false);
  const parts = visiblePath.split('/').filter(Boolean);
  const checklist = cached.records.find(record => record.id === parts[1]);
  const task = checklist?.tasks.find(record => record.id === parts[3]);
  const taskRoute = checklist && task ? `/checklists/${checklist.id}/tasks/${task.id}` : '';
  const pending = Boolean(task && commands.some(item => item.command.taskId === task.id));
  const toggle = () => {
    if (!task || pending) return;
    try { repository.enqueue({ taskId: task.id, expectedVersion: task.version, type: 'set_completed', payload: { completed: !task.completed } }); setQueueError(false); }
    catch { setQueueError(true); }
  };
  return <View style={styles.screen} testID="offline-checklist">
    <Text testID="offline-banner" style={styles.banner}>Cached view · stale · authentication unverified</Text>
    <Text style={styles.body}>Last sync: {cached.storedAt ? new Date(cached.storedAt).toLocaleString() : 'unknown'}. Connect to verify access and refresh server state.</Text>
    {visiblePath === '/sign-in' && <><Text style={styles.body}>Sign-in requires a connection.</Text><RouteButton title="View cached checklists" target="/checklists" replace /></>}
    {visiblePath === '/checklists' && <>
      <Text style={styles.title}>Your cached checklists</Text>
      {cached.records.map(record => <View key={record.id} style={styles.card}><Text style={styles.title}>{record.title}</Text><Text style={styles.body}>{record.tasks.length} tasks</Text><RouteButton title="Open checklist" target={`/checklists/${record.id}`} /></View>)}
    </>}
    {parts.length === 2 && checklist && <>
      <Text style={styles.title}>{checklist.title}</Text>
      {checklist.tasks.map(record => <View key={record.id} style={styles.card}><Text style={styles.body}>{record.completed ? '✓' : '○'} {record.title}</Text><RouteButton title="Open task" target={`/checklists/${checklist.id}/tasks/${record.id}`} /></View>)}
    </>}
    {task && parts.length === 4 && <>
      <Text style={styles.title}>{task.title}</Text><Text style={styles.body}>{task.notes || 'No notes.'}</Text>
      <Text style={styles.body}>{task.completed ? 'Completed' : 'Incomplete'} · confirmed version {task.version}</Text>
      <Pressable testID="queue-completed" accessibilityRole="button" disabled={pending} onPress={toggle} style={[styles.button, pending && styles.disabled]}><Text style={styles.buttonText}>Queue {task.completed ? 'incomplete' : 'completed'}</Text></Pressable>
      {pending && <Text style={styles.banner}>A change is queued for this task. Confirmed server values stay visible until synchronization.</Text>}
      {queueError && <Text testID="queue-completed-error" style={styles.banner}>Could not queue this change. Check pending changes and device storage.</Text>}
      {task.attachments.map((attachment, index) => <Text key={`${index}:${attachment.name}`} style={styles.body}>{attachment.name} · {attachment.size} bytes · cached metadata</Text>)}
      <RouteButton title="Edit local draft" target={`${taskRoute}/edit`} />
    </>}
    {task && parts[4] === 'edit' && cached.account && <OfflineEditor account={cached.account} task={task} taskRoute={taskRoute} />}
    {parts.length > 1 && (!checklist || (parts.length > 2 && !task)) && <><Text style={styles.body}>This route is not available in the device cache.</Text><RouteButton title="Back to checklists" target="/checklists" replace /></>}
    <Text style={styles.body}>Queued task changes sync after reconnecting and verifying your account. Uploads require a connection.</Text>
    <Pressable style={styles.button} accessibilityRole="button" onPress={live.retry}><Text style={styles.buttonText}>Reconnect</Text></Pressable>
  </View>;
}
