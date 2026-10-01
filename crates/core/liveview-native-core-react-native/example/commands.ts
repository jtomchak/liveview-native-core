export type CommandIntent = Readonly<{ taskId: string; expectedVersion: number; type: 'set_completed' | 'update_task'; payload: Readonly<{ completed: boolean; title?: string; notes?: string }> }>;
export type DurableCommand = CommandIntent & Readonly<{ operationId: string; accountId: string }>;
export type CommandReason = 'unauthorized' | 'expired' | 'quota' | 'invalid' | 'id_reused' | 'not_found';
export type PendingCommand = Readonly<{ command: DurableCommand; state: 'queued' | 'conflict' | 'review'; currentVersion?: number; reason?: CommandReason; draftKey?: string; draftSequence?: number }>;
export const operationPattern = /^\d{13}-[a-f0-9]{32}$/;
const keysEqual = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',');
export function validateIntent(value: unknown): CommandIntent {
  const intent = value as CommandIntent;
  if (!intent || !/^[A-Za-z0-9_-]{1,100}$/.test(intent.taskId) || !Number.isSafeInteger(intent.expectedVersion) || intent.expectedVersion < 1 || !['set_completed','update_task'].includes(intent.type) || !intent.payload || typeof intent.payload !== 'object' || Array.isArray(intent.payload) || typeof intent.payload.completed !== 'boolean') throw new Error('Invalid command');
  const payload = intent.payload;
  if (intent.type === 'update_task' && (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 120 || typeof payload.notes !== 'string' || payload.notes.length > 2000 || !keysEqual(payload,['title','notes','completed']))) throw new Error('Check title and notes before queuing');
  if (intent.type === 'set_completed' && !keysEqual(payload,['completed'])) throw new Error('Invalid completion command');
  return Object.freeze({taskId:intent.taskId,expectedVersion:intent.expectedVersion,type:intent.type,payload:Object.freeze({...payload})});
}
export function validateCommand(value: unknown): DurableCommand {
  const command = value as DurableCommand;
  if (!command || !keysEqual(command,['operationId','accountId','taskId','expectedVersion','type','payload']) || typeof command.operationId !== 'string' || !operationPattern.test(command.operationId) || typeof command.accountId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(command.accountId)) throw new Error('Invalid stored command');
  return Object.freeze({...validateIntent(command),operationId:command.operationId,accountId:command.accountId});
}
