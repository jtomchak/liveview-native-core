export type LiveViewNode = Readonly<{
  id: number;
  kind: 'root' | 'element' | 'text';
  tag?: string;
  attributes?: Readonly<Record<string, string | null>>;
  text?: string;
  children: readonly number[];
}>;

export type LiveViewDocument = Readonly<{
  root: number;
  nodes: ReadonlyMap<number, LiveViewNode>;
}>;

export type NativeUpdate = {
  documentGeneration?: number;
  clearDocument?: boolean;
  snapshotMs?: number;
  snapshotBytes?: number;
  callbackCount?: number;
  sessionId: string;
  revision: number;
  status: string;
  document: string | null;
  error: string | null;
};

export type LiveViewNavigation = Readonly<{ url: string | null; historyId?: string | null; action?: 'push' | 'replace' | 'traverse' | 'patch' | 'reload'; canGoBack: boolean; canGoForward: boolean }>;

export type NativeUploadAsset = Readonly<{ uri: string; name: string; mimeType: string; size?: number }>;

export type FormReply = Readonly<{ status: 'valid' | 'invalid' | 'conflict' | 'saved' | 'unauthorized' | 'stale' | 'unknown'; clientSeq?: number; version?: number }>;

export interface LiveViewTransport {
  connect(sessionId: string, url: string): Promise<void>;
  cancelUpload(sessionId: string, fieldName: string, entryRef: string): Promise<void>;
  uploadFile(sessionId: string, fieldName: string, uri: string, fileName: string, mimeType: string): Promise<void>;
  sendForm(sessionId: string, event: string, encodedValue: string, cid: number | null): Promise<string>;
  sendEvent(sessionId: string, event: string, valueJson: string): Promise<void>;
  disconnect(sessionId: string): Promise<void>;
  postForm(sessionId: string, url: string, fieldsJson: string): Promise<void>;
  logout(sessionId: string, url: string): Promise<void>;
  navigate(sessionId: string, url: string, replace: boolean): Promise<void>;
  back(sessionId: string): Promise<void>;
  forward(sessionId: string): Promise<void>;
  getNavigation(sessionId: string): Promise<string>;
  addListener(event: 'onUpdate', listener: (update: NativeUpdate) => void): {
    remove(): void;
  };
}

export type LiveViewSnapshot = Readonly<{
  sessionId: string | null;
  documentGeneration: number;
  revision: number;
  status: string;
  document: LiveViewDocument | null;
  error: string | null;
}>;

export type LiveViewSession = LiveViewSnapshot & {
  cancelUpload(fieldName: string, entryRef: string): Promise<void>;
  uploadFile(fieldName: string, asset: NativeUploadAsset): Promise<void>;
  sendForm(event: string, fields: Readonly<Record<string, string>>, changedField?: string, cid?: number): Promise<FormReply>;
  pushEvent(event: string, value?: Readonly<Record<string, unknown>>): Promise<void>;
  navigate(url: string, replace?: boolean): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  getNavigation(): Promise<LiveViewNavigation>;
  retry(): void;
  postForm(url: string, fields: Readonly<Record<string, string>>): Promise<void>;
  logout(url: string): Promise<void>;
};
