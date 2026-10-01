import { clock, measure } from './telemetry';
import { serializeForm } from './formEvents';
import { parseDocument } from './document';
import type { FormReply, LiveViewNavigation, LiveViewSnapshot, LiveViewTransport, NativeUpdate } from './types';

let nextSession = 0;
const initial: LiveViewSnapshot = Object.freeze({
  sessionId: null, documentGeneration: 0, revision: -1, status: 'idle', document: null, error: null,
});
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class LiveViewStore {
  private snapshot = initial;
  private listeners = new Set<() => void>();
  private sessionId: string | null = null;
  private nativeSubscription: { remove(): void } | null = null;
  private revision = -1;
  private startedAt = 0;
  private firstDocument = false;
  private documentGeneration = 0;

  constructor(private transport: LiveViewTransport, private url: string) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(next: LiveViewSnapshot) {
    this.snapshot = Object.freeze(next);
    this.listeners.forEach(listener => listener());
  }

  /** Unique IDs make StrictMode setup/cleanup/setup and late native callbacks safe. */
  start = () => {
    if (this.sessionId) return;
    const id = `rn-${Date.now().toString(36)}-${++nextSession}`;
    this.sessionId = id;
    this.startedAt = clock();
    this.firstDocument = false;
    this.documentGeneration = 0;
    measure('connect.start');
    this.revision = -1;
    this.publish({ ...this.snapshot, sessionId: id, documentGeneration: 0, revision: -1, status: 'connecting', error: null });
    try {
      this.nativeSubscription = this.transport.addListener('onUpdate', this.receive);
      void this.transport.connect(id, this.url).catch(error => {
        if (this.sessionId !== id) return;
        this.publish({ ...this.snapshot, status: 'error', error: message(error) });
      });
    } catch (error) {
      this.publish({ ...this.snapshot, status: 'error', error: message(error) });
    }
  };

  stop = (reason: 'stop' | 'unmount' | 'background' | 'retry' | 'logout' = 'stop') => {
    const id = this.sessionId;
    this.sessionId = null;
    this.nativeSubscription?.remove();
    this.nativeSubscription = null;
    if (id) {
      measure('disconnect', { reason });
      this.publish({ ...this.snapshot, status: 'disconnected' });
      // Teardown errors cannot update a later session or become unhandled rejections.
      void this.transport.disconnect(id).catch(() => {});
    }
  };

  retry = () => { this.stop('retry'); this.start(); };

  private receive = (update: NativeUpdate) => {
    if (update.sessionId !== this.sessionId ||
      !Number.isSafeInteger(update.revision) || update.revision <= this.revision) return;
    const generation = update.documentGeneration ?? 0;
    if (!Number.isSafeInteger(generation) || generation < this.documentGeneration) return;
    if (generation > this.documentGeneration && update.document === null) {
      this.publish({ ...this.snapshot, status: 'error', error: 'Document replacement requires a full snapshot' });
      return;
    }
    try {
      const began = clock();
      const document = update.clearDocument ? null : update.document === null
        ? this.snapshot.document : parseDocument(update.document);
      measure('document.received', { parseMs: clock() - began, nodes: document?.nodes.size ?? 0, snapshotMs: update.snapshotMs ?? 0, snapshotBytes: update.snapshotBytes ?? update.document?.length ?? 0, callbackCount: update.callbackCount ?? 0 });
      if (update.document && !this.firstDocument) {
        this.firstDocument = true;
        measure('connect.first_document', { durationMs: clock() - this.startedAt });
      }
      this.documentGeneration = generation;
      this.revision = update.revision;
      this.publish({ documentGeneration: generation, sessionId: update.sessionId, revision: update.revision, status: update.status, document, error: update.error });
    } catch (error) {
      this.revision = update.revision;
      this.publish({ ...this.snapshot, revision: update.revision, status: 'error', error: message(error) });
    }
  };

  private sameOriginUrl(url: string) {
    const target = new URL(url, this.url);
    if (target.origin !== new URL(this.url).origin || target.username || target.password) {
      throw new Error('Requests must use the LiveView origin');
    }
    return target.toString();
  }

  private connectedId() {
    if (!this.sessionId || this.snapshot.status !== 'connected') throw new Error('LiveView session is not connected');
    return this.sessionId;
  }

  /** These enqueue Rust navigation; committed route metadata confirms completion. */
  navigate = async (url: string, replace = false) => {
    const target = this.sameOriginUrl(url);
    const id = this.connectedId();
    try { await this.transport.navigate(id, target, replace); measure('navigation.request'); }
    catch (error) { if (this.sessionId === id) this.publish({ ...this.snapshot, error: message(error) }); throw error; }
  };
  private traverse = async (direction: 'back' | 'forward') => {
    const id = this.connectedId();
    try { await this.transport[direction](id); measure('navigation.request'); }
    catch (error) { if (this.sessionId === id) this.publish({ ...this.snapshot, error: message(error) }); throw error; }
  };
  back = () => this.traverse('back');
  forward = () => this.traverse('forward');
  getNavigation = async (): Promise<LiveViewNavigation> => {
    const id = this.connectedId();
    const raw = JSON.parse(await this.transport.getNavigation(id));
    if (this.sessionId !== id) throw new Error('Navigation session changed');
    if (!raw || (raw.url !== null && typeof raw.url !== 'string') || typeof raw.canGoBack !== 'boolean' || typeof raw.canGoForward !== 'boolean') throw new Error('Invalid navigation state');
    if (raw.url) this.sameOriginUrl(raw.url);
    return {url: raw.url, historyId: typeof raw.historyId === 'string' ? raw.historyId : null, action: ['push', 'replace', 'traverse', 'patch', 'reload'].includes(raw.action) ? raw.action : undefined, canGoBack: raw.canGoBack, canGoForward: raw.canGoForward};
  };

  postForm = async (url: string, fields: Readonly<Record<string, string>>) => {
    const target = this.sameOriginUrl(url);
    const id = this.sessionId;
    if (!id || this.snapshot.status !== 'connected') throw new Error('LiveView session is not connected');
    this.publish({ ...this.snapshot, document: null, status: 'authenticating', error: null });
    try {
      await this.transport.postForm(id, target, JSON.stringify(fields));
      measure('auth.form_post');
    } catch (error) {
      if (this.sessionId === id) this.publish({ ...this.snapshot, status: 'error', error: message(error) });
      throw error;
    }
  };

  logout = async (url: string) => {
    const target = this.sameOriginUrl(url);
    const id = this.sessionId;
    if (!id) throw new Error('LiveView session is not mounted');
    this.publish({ ...this.snapshot, document: null, status: 'signing-out', error: null });
    let failure: unknown;
    try { await this.transport.logout(id, target); }
    catch (error) { failure = error; }
    if (this.sessionId === id) {
      this.stop('logout'); this.publish({ ...initial, error: failure ? message(failure) : null }); this.start();
      measure(failure ? 'auth.local_logout' : 'auth.logout');
      if (failure) this.publish({ ...this.snapshot, error: 'Local session cleared; server revocation was not confirmed' });
    }
    if (failure) throw failure;
  };

  sendForm = async (event: string, fields: Readonly<Record<string, string>>, changedField?: string, cid?: number): Promise<FormReply> => {
    if (!event || event.length > 128 || !fields || Array.isArray(fields) ||
      Object.values(fields).some(value => typeof value !== 'string') ||
      (changedField !== undefined && !Object.hasOwn(fields, changedField)) ||
      (cid !== undefined && (!Number.isSafeInteger(cid) || cid <= 0))) throw new Error('Invalid form request');
    const id = this.connectedId();
    const generation = this.documentGeneration;
    const encoded = serializeForm(fields, changedField);
    if (encoded.length > 256 * 1024) throw new Error('Form is too large');
    const began = clock();
    try {
      const envelope = JSON.parse(await this.transport.sendForm(id, event, encoded, cid ?? null));
      if (this.sessionId !== id) throw new Error('Form session changed');
      // Phoenix LiveView nests handle_event replies in diff.r.
      const reply = envelope?.diff?.r ?? envelope?.reply;
      const status = ['valid', 'invalid', 'conflict', 'saved', 'unauthorized', 'stale'].includes(reply?.status) ? reply.status : 'unknown';
      if (reply?.client_seq !== undefined && (!Number.isSafeInteger(reply.client_seq) || reply.client_seq < 0)) throw new Error('Invalid form reply');
      if (reply?.version !== undefined && (!Number.isSafeInteger(reply.version) || reply.version < 1)) throw new Error('Invalid form reply');
      measure('form.reply', {durationMs: clock() - began, outcome: status});
      return {status, clientSeq: reply?.client_seq, version: reply?.version};
    } catch (error) {
      if (this.sessionId === id && this.documentGeneration === generation) this.publish({ ...this.snapshot, error: message(error) });
      throw error;
    }
  };

  pushEvent = async (event: string, value: Readonly<Record<string, unknown>> = {}) => {
    const id = this.sessionId;
    if (!id) throw new Error('LiveView session is not mounted');
    if (this.snapshot.status.toLowerCase() !== 'connected') throw new Error('LiveView session is not connected');
    try {
      const began = clock();
      measure('event.sent');
      await this.transport.sendEvent(id, event, JSON.stringify(value));
      measure('event.reply', { durationMs: clock() - began });
    } catch (error) {
      if (this.sessionId === id) this.publish({ ...this.snapshot, error: message(error) });
      throw error;
    }
  };
}
