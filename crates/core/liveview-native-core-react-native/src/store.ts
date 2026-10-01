import { clock, measure } from './telemetry';
import { parseDocument } from './document';
import type { LiveViewSnapshot, LiveViewTransport, NativeUpdate } from './types';

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

  stop = () => {
    const id = this.sessionId;
    this.sessionId = null;
    this.nativeSubscription?.remove();
    this.nativeSubscription = null;
    if (id) {
      measure('disconnect');
      this.publish({ ...this.snapshot, status: 'disconnected' });
      // Teardown errors cannot update a later session or become unhandled rejections.
      void this.transport.disconnect(id).catch(() => {});
    }
  };

  retry = () => { this.stop(); this.start(); };

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

  private authUrl(url: string) {
    const target = new URL(url, this.url);
    if (target.origin !== new URL(this.url).origin || target.username || target.password) {
      throw new Error('Authentication must use the LiveView origin');
    }
    return target.toString();
  }

  postForm = async (url: string, fields: Readonly<Record<string, string>>) => {
    const target = this.authUrl(url);
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
    const target = this.authUrl(url);
    const id = this.sessionId;
    if (!id) throw new Error('LiveView session is not mounted');
    this.publish({ ...this.snapshot, document: null, status: 'signing-out', error: null });
    let failure: unknown;
    try { await this.transport.logout(id, target); }
    catch (error) { failure = error; }
    if (this.sessionId === id) {
      this.stop(); this.publish({ ...initial, error: failure ? message(failure) : null }); this.start();
      measure(failure ? 'auth.local_logout' : 'auth.logout');
      if (failure) this.publish({ ...this.snapshot, error: 'Local session cleared; server revocation was not confirmed' });
    }
    if (failure) throw failure;
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
