export type PickedUploadAsset = Readonly<{ uri: string; name: string; mimeType: string; size?: number }>;
export type PickUpload = () => Promise<PickedUploadAsset | null>;
export type UploadState = Readonly<{
  phase: 'idle' | 'picking' | 'uploading' | 'awaiting' | 'ready' | 'saved' | 'cancelled' | 'error';
  busy: boolean; entryRef: string | null; asset: PickedUploadAsset | null; progress: number | null; error: string | null;
}>;
const maxBytes = 2 * 1024 * 1024;
export function validateUploadAsset(asset: PickedUploadAsset) {
  if (!['image/png', 'text/plain'].includes(asset.mimeType) || !/\.(png|txt)$/i.test(asset.name)) throw new Error('Choose a PNG image or text file.');
  if (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxBytes)) throw new Error('Choose a file smaller than or equal to 2 MiB.');
  if (!/^(file|content):\/\//i.test(asset.uri)) throw new Error('Choose a local file using the document picker.');
}
/** Selection and transfer are local; only server metadata can claim ready/saved. */
export class UploadController {
  private state: UploadState = Object.freeze({ phase: 'idle', busy: false, entryRef: null, asset: null, progress: null, error: null });
  private listeners = new Set<() => void>();
  private alive = true;
  private token = 0;
  private ref: string | null = null;
  private cancelledRefs = new Set<string>();
  private signature: string | null = null;
  constructor(private readonly pick: PickUpload | undefined, private readonly transfer: (asset: PickedUploadAsset) => Promise<void>) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<UploadState>) { this.state = Object.freeze({ ...this.state, ...patch }); for (const listener of this.listeners) listener(); }
  async select(connected: boolean) {
    if (!this.alive || !connected || this.state.busy || (this.state.phase === 'error' && this.state.entryRef !== null) || ['ready', 'awaiting', 'uploading'].includes(this.state.phase)) return;
    if (!this.pick) { this.publish({ phase: 'error', error: 'A document picker must be installed by this React Native bundle.' }); return; }
    const token = ++this.token;
    this.publish({ phase: 'picking', busy: true, asset: null, progress: null, error: null });
    try {
      const asset = await this.pick();
      if (!this.alive || token !== this.token) return;
      if (!asset) { this.publish({ phase: 'idle', busy: false }); return; }
      validateUploadAsset(asset);
      this.publish({ phase: 'uploading', asset: Object.freeze({ ...asset }), progress: null });
      await this.transfer(asset);
      if (!this.alive || token !== this.token) return;
      this.publish({ busy: false, phase: this.state.phase === 'uploading' ? 'awaiting' : this.state.phase });
    } catch (error) {
      if (this.alive && token === this.token) this.publish({ phase: 'error', busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  updateServer(status: string, ref: string | null, progress: number | null, errors: readonly string[] = []) {
    if (!this.alive || (ref !== null && this.cancelledRefs.has(ref))) return;
    const safeProgress = progress !== null && Number.isInteger(progress) && progress >= 0 && progress <= 100 ? progress : null;
    const signature = JSON.stringify([status, ref, safeProgress, errors]);
    if (signature === this.signature) return;
    this.signature = signature;
    const previousRef = this.ref;
    const disappeared = previousRef !== null && ref === null;
    if (status === 'cancelled' || status === 'saved' || (disappeared && status !== 'error')) {
      if (previousRef) this.cancelledRefs.add(previousRef);
      if (status === 'cancelled' && ref) this.cancelledRefs.add(ref);
    }
    this.ref = ref;
    this.publish({ entryRef: ref });
    if (status === 'saved' || status === 'cancelled' || (disappeared && status !== 'error')) {
      this.token++;
      this.publish({ phase: status === 'saved' ? 'saved' : 'cancelled', busy: false, progress: null, error: null });
    } else if (status === 'error') {
      this.token++;
      this.publish({ phase: 'error', busy: false, progress: safeProgress, error: errors.join('\n') || 'The upload failed. Cancel the entry and choose the file again.' });
    } else if (status === 'ready' && safeProgress === 100) {
      this.publish({ phase: 'ready', progress: 100, error: null });
    } else if (status === 'uploading' || ref !== null) {
      this.publish({ phase: 'uploading', progress: safeProgress, error: errors.length ? errors.join('\n') : null });
    }
  }
  activate() { this.alive = true; }
  dispose() { this.alive = false; this.token++; this.listeners.clear(); }
}
