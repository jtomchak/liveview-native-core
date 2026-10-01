import { clock, measure } from './telemetry';
import { parseDocument } from './document';
import type { LiveViewSnapshot, LiveViewTransport, NativeUpdate } from './types';

let nextSession = 0;
const initial: LiveViewSnapshot = Object.freeze({
  sessionId: null, revision: -1, status: 'idle', document: null, error: null,
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
    measure('connect.start');
    this.revision = -1;
    this.publish({ ...this.snapshot, sessionId: id, revision: -1, status: 'connecting', error: null });
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
    try {
      const began = clock();
      const document = update.document === null
        ? this.snapshot.document : parseDocument(update.document);
      measure('document.received', { parseMs: clock() - began, nodes: document?.nodes.size ?? 0, snapshotMs: update.snapshotMs ?? 0, snapshotBytes: update.snapshotBytes ?? update.document?.length ?? 0, callbackCount: update.callbackCount ?? 0 });
      if (update.document && !this.firstDocument) {
        this.firstDocument = true;
        measure('connect.first_document', { durationMs: clock() - this.startedAt });
      }
      this.revision = update.revision;
      this.publish({ sessionId: update.sessionId, revision: update.revision, status: update.status, document, error: update.error });
    } catch (error) {
      this.revision = update.revision;
      this.publish({ ...this.snapshot, revision: update.revision, status: 'error', error: message(error) });
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
