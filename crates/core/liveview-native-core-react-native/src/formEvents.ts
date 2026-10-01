export function serializeForm(fields: Readonly<Record<string, string>>, changedField?: string) {
  const payload = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) payload.append(name, value);
  if (changedField) payload.set('_target', changedField);
  return payload.toString();
}

export type FormDraft = Readonly<{ fields: Readonly<Record<string, string>>; sequence: number; submissionId?: string }>;
export interface FormDraftStore {
  get(key: string): FormDraft | undefined;
  set(key: string, draft: FormDraft): void;
  delete(key: string): void;
  clearAccount(account: string): void;
  clear(): void;
}
export class MemoryFormDraftStore implements FormDraftStore {
  private drafts = new Map<string, FormDraft>();
  constructor(private readonly limit = 100) { if (!Number.isInteger(limit) || limit < 1) throw new Error('Draft limit must be a positive integer'); }
  get(key: string) { return this.drafts.get(key); }
  set(key: string, draft: FormDraft) {
    this.drafts.delete(key);
    this.drafts.set(key, Object.freeze({ ...draft, fields: Object.freeze({ ...draft.fields }) }));
    while (this.drafts.size > this.limit) this.drafts.delete(this.drafts.keys().next().value!);
  }
  delete(key: string) { this.drafts.delete(key); }
  clearAccount(account: string) { for (const key of this.drafts.keys()) if (key.startsWith(`${account}:`)) this.drafts.delete(key); }
  clear() { this.drafts.clear(); }
}
export type FormResponse = { status: 'valid' | 'invalid' | 'conflict' | 'saved' | 'unauthorized' | 'stale' | 'unknown'; clientSeq?: number; version?: number };
export type FormState = Readonly<{
  fields: Readonly<Record<string, string>>; sequence: number; dirty: boolean; submitting: boolean;
  errors: Readonly<Record<string, string>>; error: string | null;
}>;
export type SendForm = (event: string, fields: Readonly<Record<string, string>>, changedField?: string, cid?: number) => Promise<FormResponse>;
let nextSubmission = 0;
/** Local fields outlive server patches; transport promises never own newer edits. */
export class FormController {
  private state: FormState;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private alive = true;
  private lifecycle = 0;
  private baseline: Readonly<Record<string, string>>;
  constructor(readonly key: string, initial: Readonly<Record<string, string>>, private readonly drafts: FormDraftStore,
    private readonly send: SendForm, private readonly changeEvent: string | null, private readonly submitEvent: string | null,
    private readonly debounce = 250, private readonly cid?: number,
    private readonly onSaved?: () => Promise<void>, private readonly onUnauthorized?: () => Promise<void>) {
    this.baseline = Object.freeze({ ...initial });
    const draft = drafts.get(key);
    this.state = Object.freeze({ fields: draft?.fields ?? this.baseline, sequence: draft?.sequence ?? 0,
      dirty: Boolean(draft), submitting: false, errors: Object.freeze({}), error: null });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<FormState>) {
    this.state = Object.freeze({ ...this.state, ...patch,
      fields: patch.fields ? Object.freeze({ ...patch.fields }) : this.state.fields,
      errors: patch.errors ? Object.freeze({ ...patch.errors }) : this.state.errors });
    for (const listener of this.listeners) listener();
  }
  private persist(submissionId?: string) { this.drafts.set(this.key, { fields: this.state.fields, sequence: this.state.sequence, submissionId }); }
  private cancelTimer() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  setField(name: string, value: string) {
    if (!this.alive || this.state.submitting || !Object.hasOwn(this.state.fields, name)) return;
    if (this.state.fields[name] === value) return;
    this.publish({ fields: Object.freeze({ ...this.state.fields, [name]: value }), sequence: this.state.sequence + 1,
      dirty: true, errors: {}, error: null });
    this.persist(); this.cancelTimer();
    if (this.changeEvent) this.timer = setTimeout(() => { this.timer = null; void this.validate(name); }, this.debounce);
  }
  private async validate(changedField?: string) {
    if (!this.alive || this.state.submitting || !this.changeEvent) return;
    const sequence = this.state.sequence;
    const lifecycle = this.lifecycle;
    try {
      const reply = await this.send(this.changeEvent, { ...this.state.fields, client_seq: String(sequence) }, changedField, this.cid);
      if (!this.alive || lifecycle !== this.lifecycle || this.state.sequence !== sequence || this.state.submitting) return;
      if (reply.status === 'unauthorized') {
        this.publish({ error: 'Sign in to continue.' });
        if (reply.clientSeq === sequence) await this.onUnauthorized?.();
      }
    } catch (error) {
      if (this.alive && lifecycle === this.lifecycle && this.state.sequence === sequence && !this.state.submitting) this.publish({ error: error instanceof Error ? error.message : String(error) });
    }
  }
  updateServer(fields: Readonly<Record<string, string>>, validatedSequence: number, errors: Readonly<Record<string, string>>, status?: string) {
    if (!this.alive) return;
    if (!this.state.dirty && !this.state.submitting) { this.baseline = Object.freeze({ ...fields }); this.publish({ fields: this.baseline }); }
    if (validatedSequence >= this.state.sequence) this.publish({ errors, error: status === 'conflict' ? 'The task changed on the server. Your draft has been kept. Cancel and reopen to use the latest version.' : null });
  }
  async submit(connected: boolean) {
    if (!this.alive || !connected || this.state.submitting || !this.submitEvent) return;
    this.cancelTimer();
    const sequence = this.state.sequence + 1;
    const submissionId = `form-${++nextSubmission}`;
    const lifecycle = this.lifecycle;
    this.publish({ sequence, submitting: true, error: null }); this.persist(submissionId);
    try {
      const reply = await this.send(this.submitEvent, { ...this.state.fields, client_seq: String(sequence) }, undefined, this.cid);
      if (reply.status === 'saved' && reply.clientSeq === sequence) {
        const draft = this.drafts.get(this.key);
        if (draft?.sequence === sequence && draft.submissionId === submissionId) this.drafts.delete(this.key);
        // A navigation may unmount the Form before its acknowledged save resolves.
        if (!this.alive || lifecycle !== this.lifecycle || this.state.sequence !== sequence) return;
        const fields = { ...this.state.fields };
        if (reply.version !== undefined && Object.hasOwn(fields, 'task[version]')) fields['task[version]'] = String(reply.version);
        this.baseline = Object.freeze(fields);
        this.publish({ fields, dirty: false, submitting: Boolean(this.onSaved), errors: {}, error: null });
        if (this.onSaved) {
          try { await this.onSaved(); }
          catch (error) {
            if (this.alive && lifecycle === this.lifecycle && this.state.sequence === sequence) this.publish({ error: `Task saved, but navigation failed: ${error instanceof Error ? error.message : String(error)}` });
          }
          if (this.alive && lifecycle === this.lifecycle && this.state.sequence === sequence) this.publish({ submitting: false });
        }
      } else if (this.alive && lifecycle === this.lifecycle && this.state.sequence === sequence) {
        const error = reply.status === 'conflict' ? 'The task changed on the server. Your draft has been kept. Cancel and reopen to use the latest version.'
          : reply.status === 'unauthorized' ? 'Sign in to continue.' : 'Check the form and try again. Your draft has been kept.';
        this.publish({ submitting: false, error });
        if (reply.status === 'unauthorized' && reply.clientSeq === sequence) await this.onUnauthorized?.();
      }
    } catch (error) {
      if (this.alive && lifecycle === this.lifecycle && this.state.sequence === sequence) this.publish({ submitting: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  cancel() { this.cancelTimer(); this.drafts.delete(this.key); }
  activate() { this.alive = true; }
  dispose() { this.alive = false; this.lifecycle++; this.cancelTimer(); this.listeners.clear(); }
}
