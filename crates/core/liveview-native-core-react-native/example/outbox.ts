import type { LiveViewSession } from '../src/types';
import { OfflineRepository, type PendingCommand, type CommandReason } from './offlineRepository';
type Metric = (name: string, attributes: Record<string, number | string>) => void;
/** Replays installed desired-state commands; DOM events are never stored here. */
export class OutboxRunner {
  private connection: LiveViewSession | null = null;
  private account: string | null = null;
  private generation = 0;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private failures = 0;
  private blocked = false;
  constructor(private readonly repository: OfflineRepository, private readonly metric: Metric = () => {}) {}
  setConnection(live: LiveViewSession, verifiedAccount: string | null) {
    if (!this.unsubscribe) this.unsubscribe = this.repository.subscribeCommands(() => { void this.flush(); });
    const available = live.status === 'connected' && verifiedAccount !== null && verifiedAccount === this.repository.getSnapshot().account;
    const nextAccount = available ? verifiedAccount : null;
    if (this.connection?.sessionId !== live.sessionId || this.account !== nextAccount) {
      this.generation++; this.failures = 0; this.blocked = false;
      if (this.timer) clearTimeout(this.timer); this.timer = null;
    }
    this.connection = live; this.account = nextAccount;
    if (available) void this.flush();
  }
  getState = () => ({ sending: this.active, online: Boolean(this.account), attempts: this.failures });
  private owns(generation: number, account: string) { return this.generation === generation && this.account === account && this.repository.getSnapshot().account === account; }
  async flush() {
    if (this.active || this.timer || this.blocked || !this.account || !this.connection || this.connection.status !== 'connected') return;
    const account = this.account; const generation = this.generation; this.active = true;
    let delayed = false;
    try {
      while (this.owns(generation, account)) {
        const pending = this.repository.getCommands().find(item => item.state === 'queued'); if (!pending) break;
        const began = performance.now();
        try {
          const reply = await this.connection!.callEvent('execute_command', { command: pending.command });
          if (!this.owns(generation, account)) break;
          this.accept(pending, reply);
          this.failures = 0;
          this.metric('offline.command_reply', { durationMs: performance.now() - began, outcome: String(reply.status) });
          if (reply.status === 'unauthorized') { this.blocked = true; break; }
        } catch {
          if (!this.owns(generation, account)) break;
          this.failures++;
          const delay = Math.min(30000, 500 * 2 ** Math.min(this.failures - 1, 6));
          this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delay); delayed = true;
          this.metric('offline.command_retry', { attempts: this.failures, delayMs: delay }); break;
        }
      }
    } finally {
      this.active = false;
      // A changed connection may have arrived while the old request was settling.
      if (!delayed && generation !== this.generation) void this.flush();
    }
  }
  private accept(pending: PendingCommand, reply: Readonly<Record<string, unknown>>) {
    const command = pending.command;
    if (reply.operationId !== command.operationId || reply.taskId !== command.taskId) throw new Error('Unmatched command acknowledgement');
    if (reply.status === 'unavailable') throw new Error('Command service unavailable');
    if (reply.status === 'committed') {
      if (!Number.isSafeInteger(reply.version) || Number(reply.version) < command.expectedVersion || !Number.isSafeInteger(reply.committedAt) || !Number.isSafeInteger(reply.retainedUntil) || Number(reply.retainedUntil) <= Number(reply.committedAt)) throw new Error('Invalid committed receipt');
      this.repository.acknowledge(command.operationId);
    } else if (reply.status === 'conflict') {
      if (!Number.isSafeInteger(reply.currentVersion) || Number(reply.currentVersion) < 1) throw new Error('Invalid conflict receipt');
      this.repository.markCommand(command.operationId, 'conflict', Number(reply.currentVersion));
    } else if (['unauthorized','expired','quota','invalid','id_reused','not_found'].includes(String(reply.status))) {
      this.repository.markCommand(command.operationId, 'review', undefined, reply.status as CommandReason);
    } else throw new Error('Unknown command acknowledgement');
  }
  dispose() {
    this.generation++; this.connection = null; this.account = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
  }
}
