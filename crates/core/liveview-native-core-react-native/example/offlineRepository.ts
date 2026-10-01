import { validateIntent, validateCommand, type CommandIntent, type DurableCommand, type PendingCommand, type CommandReason } from './commands';
export type { CommandIntent, DurableCommand, PendingCommand, CommandReason } from './commands';
import type { FormDraft, FormDraftStore } from '../src/formEvents';
export type CachedAttachment = Readonly<{ name: string; size: number }>;
export type CachedTask = Readonly<{ id: string; title: string; notes: string; completed: boolean; version: number; attachments: readonly CachedAttachment[] }>;
export type CachedChecklist = Readonly<{ id: string; title: string; tasks: readonly CachedTask[] }>;
export type OfflineSnapshot = Readonly<{ origin: string; account: string | null; records: readonly CachedChecklist[]; storedAt: number | null }>;
export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, ...params: (string | number | null)[]): void;
  all<T>(sql: string, ...params: (string | number | null)[]): T[];
  first<T>(sql: string, ...params: (string | number | null)[]): T | null;
}
type Metric = (name: string, attributes: Record<string, number | boolean>) => void;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
function recordsFrom(json: string): readonly CachedChecklist[] {
  if (json.length > 524288) throw new Error('Cache limit exceeded');
  const input: unknown = JSON.parse(json);
  if (!Array.isArray(input) || input.length > 20) throw new Error('Invalid checklist cache');
  const ids = new Set<string>(); let count = 0;
  return Object.freeze(input.map(record => {
    if (!record || !validId(record.id) || ids.has(record.id) || !text(record.title, 200) || !Array.isArray(record.tasks)) throw new Error('Invalid checklist');
    ids.add(record.id);
    const tasks = record.tasks.map((task: any) => {
      if (++count > 300 || !task || !validId(task.id) || ids.has(task.id) || !text(task.title, 200) || !text(task.notes, 4000) || typeof task.completed !== 'boolean' || !Number.isSafeInteger(task.version) || task.version < 1 || !Array.isArray(task.attachments) || task.attachments.length > 100) throw new Error('Invalid task');
      ids.add(task.id);
      const attachments = task.attachments.map((item: any) => {
        if (!item || !text(item.name, 200) || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 2097152) throw new Error('Invalid attachment');
        return Object.freeze({ name: item.name, size: item.size });
      });
      return Object.freeze({ id: task.id, title: task.title, notes: task.notes, completed: task.completed, version: task.version, attachments: Object.freeze(attachments) });
    });
    return Object.freeze({ id: record.id, title: record.title, tasks: Object.freeze(tasks) });
  }));
}
function draftFrom(value: unknown): FormDraft {
  const draft = value as FormDraft;
  if (!draft || !draft.fields || typeof draft.fields !== 'object' || Array.isArray(draft.fields) || !Number.isSafeInteger(draft.sequence) || draft.sequence < 0 || (draft.submissionId !== undefined && !text(draft.submissionId, 100))) throw new Error('Invalid draft');
  const entries = Object.entries(draft.fields);
  if (entries.length > 16 || entries.some(([key, value]) => !/^task\[(id|version|title|notes|completed)\]$/.test(key) || !text(value, 4000)) || JSON.stringify(draft).length > 12000) throw new Error('Draft limit exceeded');
  return Object.freeze({ fields: Object.freeze({ ...draft.fields }), sequence: draft.sequence, ...(draft.submissionId ? { submissionId: draft.submissionId } : {}) });
}
/** Only confirmed signed-in documents activate a scope. Credentials never enter this database. */
export class OfflineRepository implements FormDraftStore {
  private snapshot: OfflineSnapshot;
  private listeners = new Set<() => void>();
  private commands: readonly PendingCommand[] = Object.freeze([]);
  private commandListeners = new Set<() => void>();
  constructor(private readonly db: SqlDriver, origin: string, private readonly metric: Metric = () => {}) {
    origin = new URL(origin).origin;
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS offline_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS offline_cache (origin TEXT NOT NULL, account TEXT NOT NULL, records TEXT NOT NULL, stored_at INTEGER NOT NULL, PRIMARY KEY(origin,account));
      CREATE TABLE IF NOT EXISTS offline_drafts (origin TEXT NOT NULL, account TEXT NOT NULL, key TEXT NOT NULL, draft TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(origin,account,key));
      CREATE TABLE IF NOT EXISTS offline_commands (origin TEXT NOT NULL, account TEXT NOT NULL, operation_id TEXT PRIMARY KEY, command TEXT NOT NULL, state TEXT NOT NULL, current_version INTEGER, reason TEXT, draft_key TEXT, draft_sequence INTEGER);
      PRAGMA user_version=2;`);
    this.snapshot = Object.freeze({ origin, account: null, records: Object.freeze([]), storedAt: null });
    try {
      const scope = db.first<{ value: string }>('SELECT value FROM offline_meta WHERE key=?', 'scope');
      if (scope) {
        const saved = JSON.parse(scope.value);
        if (saved.origin !== origin || !validId(saved.account)) { this.clear(); return; }
        const row = db.first<{ records: string; stored_at: number }>('SELECT records,stored_at FROM offline_cache WHERE origin=? AND account=?', origin, saved.account);
        if (!row || !Number.isSafeInteger(row.stored_at) || row.stored_at < 0) { this.clear(); return; }
        this.snapshot = Object.freeze({ origin, account: saved.account, records: recordsFrom(row.records), storedAt: row.stored_at });
        this.reloadCommands();
      }
    } catch { this.clear(); }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(snapshot: OfflineSnapshot) { this.snapshot = Object.freeze(snapshot); this.listeners.forEach(listener => listener()); }
  private transaction(operation: () => void) {
    this.db.exec('BEGIN IMMEDIATE');
    try { operation(); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  bindOrigin(origin: string) {
    origin = new URL(origin).origin;
    if (origin !== this.snapshot.origin) { this.clear(); this.publish({ ...this.snapshot, origin }); }
  }
  capture(account: string, recordsJson: string) {
    if (!validId(account)) throw new Error('Invalid account');
    const records = recordsFrom(recordsJson); const { origin } = this.snapshot; const storedAt = Date.now(); const start = performance.now();
    this.transaction(() => {
      if (this.snapshot.account && this.snapshot.account !== account) { this.db.run('DELETE FROM offline_cache'); this.db.run('DELETE FROM offline_drafts'); this.db.run('DELETE FROM offline_commands'); }
      this.db.run('INSERT OR REPLACE INTO offline_cache(origin,account,records,stored_at) VALUES(?,?,?,?)', origin, account, JSON.stringify(records), storedAt);
      this.db.run('INSERT OR REPLACE INTO offline_meta(key,value) VALUES(?,?)', 'scope', JSON.stringify({ origin, account }));
    });
    this.publish({ origin, account, records, storedAt });
    this.reloadCommands();
    this.metric('offline.cache_write', { durationMs: performance.now() - start, records: records.reduce((n, record) => n + record.tasks.length, 0) });
  }
  get(key: string): FormDraft | undefined {
    const { account, origin } = this.snapshot; if (!account || !key.startsWith(`${account}:`)) return;
    const start = performance.now();
    const row = this.db.first<{ draft: string }>('SELECT draft FROM offline_drafts WHERE origin=? AND account=? AND key=?', origin, account, key);
    this.metric('offline.draft_read', { durationMs: performance.now() - start, hit: Boolean(row) });
    if (!row) return;
    try { if (row.draft.length > 12000) throw new Error('Oversized draft'); return draftFrom(JSON.parse(row.draft)); }
    catch { this.delete(key); return; }
  }
  set(key: string, value: FormDraft) {
    const { account, origin } = this.snapshot; if (!account || !key.startsWith(`${account}:`) || key.length > 220) return;
    const draft = draftFrom(value); const start = performance.now();
    this.transaction(() => {
      this.db.run('INSERT OR REPLACE INTO offline_drafts(origin,account,key,draft,updated_at) VALUES(?,?,?,?,?)', origin, account, key, JSON.stringify(draft), Date.now());
      this.db.run('DELETE FROM offline_drafts WHERE rowid IN (SELECT rowid FROM offline_drafts ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET 100)');
    });
    this.metric('offline.draft_write', { durationMs: performance.now() - start });
  }
  delete(key: string) {
    if (this.snapshot.account) this.db.run('DELETE FROM offline_drafts WHERE origin=? AND account=? AND key=?', this.snapshot.origin, this.snapshot.account, key);
  }
  clearAccount(account: string) {
    if (this.snapshot.account === account) this.clear();
    else this.transaction(() => { this.db.run('DELETE FROM offline_cache WHERE account=?', account); this.db.run('DELETE FROM offline_drafts WHERE account=?', account); this.db.run('DELETE FROM offline_commands WHERE account=?', account); });
  }
  clear() {
    const empty = Object.freeze({ origin: this.snapshot.origin, account: null, records: Object.freeze([]), storedAt: null });
    this.snapshot = empty; // Block stale form callbacks before notifying subscribers.
    this.transaction(() => { this.db.run('DELETE FROM offline_meta'); this.db.run('DELETE FROM offline_cache'); this.db.run('DELETE FROM offline_drafts'); this.db.run('DELETE FROM offline_commands'); });
    this.publish(empty);
    this.reloadCommands();
  }
  getCommands = () => this.commands;
  subscribeCommands = (listener: () => void) => { this.commandListeners.add(listener); return () => { this.commandListeners.delete(listener); }; };
  private reloadCommands() {
    const { origin, account } = this.snapshot;
    const rows = account ? this.db.all<{ operation_id: string; command: string; state: string; current_version: number | null; reason: string | null; draft_key: string | null; draft_sequence: number | null }>('SELECT * FROM offline_commands WHERE origin=? AND account=? ORDER BY rowid LIMIT 100', origin, account) : [];
    const next: PendingCommand[] = [];
    for (const row of rows) {
      try {
        if (row.command.length > 12000) throw new Error('Oversized command');
        const command = validateCommand(JSON.parse(row.command));
        if (command.accountId !== account || command.operationId !== row.operation_id || !['queued','conflict','review'].includes(row.state) || (row.current_version !== null && (!Number.isSafeInteger(row.current_version) || row.current_version < 1)) || (row.reason !== null && !['unauthorized','expired','quota','invalid','id_reused','not_found'].includes(row.reason)) || (row.draft_key !== null && (!row.draft_key.startsWith(`${account}:`) || row.draft_key.length > 220)) || (row.draft_sequence !== null && (!Number.isSafeInteger(row.draft_sequence) || row.draft_sequence < 0))) throw new Error('Invalid command row');
        next.push(Object.freeze({ command, state: row.state as PendingCommand['state'], ...(row.current_version !== null ? { currentVersion: row.current_version } : {}), ...(row.reason !== null ? { reason: row.reason as CommandReason } : {}), ...(row.draft_key !== null ? { draftKey: row.draft_key } : {}), ...(row.draft_sequence !== null ? { draftSequence: row.draft_sequence } : {}) }));
      } catch { this.db.run('DELETE FROM offline_commands WHERE operation_id=?', row.operation_id); }
    }
    this.commands = Object.freeze(next); this.commandListeners.forEach(listener => listener());
  }
  private makeCommand(intent: CommandIntent): DurableCommand {
    const validated = validateIntent(intent); const { account } = this.snapshot;
    if (!account || !this.snapshot.records.some(record => record.tasks.some(task => task.id === intent.taskId))) throw new Error('No confirmed cached task');
    const random = this.db.first<{ id: string }>('SELECT lower(hex(randomblob(16))) AS id')!.id;
    return Object.freeze({...validated, accountId: account, operationId: `${Date.now()}-${random}`});
  }
  private insertCommand(command: DurableCommand, draftKey?: string, draftSequence?: number) {
    this.db.run('INSERT INTO offline_commands(origin,account,operation_id,command,state,draft_key,draft_sequence) VALUES(?,?,?,?,?,?,?)', this.snapshot.origin, command.accountId, command.operationId, JSON.stringify(command), 'queued', draftKey ?? null, draftSequence ?? null);
    if (draftKey !== undefined && draftSequence !== undefined) {
      const draft = this.get(draftKey);
      if (draft?.sequence === draftSequence) this.db.run('UPDATE offline_drafts SET draft=? WHERE origin=? AND account=? AND key=?', JSON.stringify({...draft, submissionId: command.operationId}), this.snapshot.origin, command.accountId, draftKey);
    }
  }
  enqueue(intent: CommandIntent, draftKey?: string, draftSequence?: number): PendingCommand {
    if (this.commands.length >= 100 || this.commands.some(item => item.command.taskId === intent.taskId)) throw new Error('This task already has a pending action or the queue is full');
    if (draftKey !== undefined && (!draftKey.startsWith(`${this.snapshot.account}:`) || draftKey.length > 220 || !Number.isSafeInteger(draftSequence) || draftSequence! < 0)) throw new Error('Invalid queued draft');
    const command = this.makeCommand(intent); const start = performance.now();
    this.transaction(() => this.insertCommand(command, draftKey, draftSequence)); this.reloadCommands();
    this.metric('offline.command_queued', { durationMs: performance.now() - start, pending: this.commands.length });
    return this.commands.find(item => item.command.operationId === command.operationId)!;
  }
  acknowledge(operationId: string) {
    const pending = this.commands.find(item => item.command.operationId === operationId); if (!pending) return;
    this.transaction(() => {
      if (pending.draftKey) {
        const draft = this.get(pending.draftKey);
        if (draft?.submissionId === operationId && draft.sequence === pending.draftSequence) this.db.run('DELETE FROM offline_drafts WHERE origin=? AND account=? AND key=?', this.snapshot.origin, this.snapshot.account, pending.draftKey);
      }
      this.db.run('DELETE FROM offline_commands WHERE origin=? AND account=? AND operation_id=?', this.snapshot.origin, this.snapshot.account, operationId);
    }); this.reloadCommands();
  }
  markCommand(operationId: string, state: 'conflict' | 'review', currentVersion?: number, reason?: CommandReason) {
    if (!this.commands.some(item => item.command.operationId === operationId)) return;
    if (state === 'conflict' && (!Number.isSafeInteger(currentVersion) || currentVersion! < 1)) throw new Error('Invalid conflict version');
    this.db.run('UPDATE offline_commands SET state=?,current_version=?,reason=? WHERE origin=? AND account=? AND operation_id=?', state, currentVersion ?? null, reason ?? null, this.snapshot.origin, this.snapshot.account, operationId); this.reloadCommands();
  }
  discardCommand(operationId: string) {
    this.db.run('DELETE FROM offline_commands WHERE origin=? AND account=? AND operation_id=?', this.snapshot.origin, this.snapshot.account, operationId); this.reloadCommands();
  }
  reapplyCommand(operationId: string, currentVersion: number): PendingCommand {
    const old = this.commands.find(item => item.command.operationId === operationId);
    const task = this.snapshot.records.flatMap(record => record.tasks).find(task => task.id === old?.command.taskId);
    if (!old || old.state === 'queued' || !task || task.version !== currentVersion) throw new Error('Refresh the current task before reapplying');
    const command = this.makeCommand({...old.command, expectedVersion: currentVersion});
    const existingDraft = old.draftKey ? this.get(old.draftKey) : undefined;
    const ownsDraft = existingDraft?.submissionId === operationId && existingDraft.sequence === old.draftSequence;
    this.transaction(() => {
      this.db.run('DELETE FROM offline_commands WHERE origin=? AND account=? AND operation_id=?', this.snapshot.origin, this.snapshot.account, operationId);
      if (old.draftKey) {
        const draft = this.get(old.draftKey);
        if (draft?.submissionId === operationId && draft.sequence === old.draftSequence) this.db.run('UPDATE offline_drafts SET draft=? WHERE origin=? AND account=? AND key=?', JSON.stringify({...draft, fields: {...draft.fields, 'task[version]': String(currentVersion)}}), this.snapshot.origin, this.snapshot.account, old.draftKey);
      }
      this.insertCommand(command, ownsDraft ? old.draftKey : undefined, ownsDraft ? old.draftSequence : undefined);
    }); this.reloadCommands(); return this.commands.find(item => item.command.operationId === command.operationId)!;
  }

}
