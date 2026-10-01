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
  snapshotMs?: number;
  snapshotBytes?: number;
  callbackCount?: number;
  sessionId: string;
  revision: number;
  status: string;
  document: string | null;
  error: string | null;
};

export interface LiveViewTransport {
  connect(sessionId: string, url: string): Promise<void>;
  sendEvent(sessionId: string, event: string, valueJson: string): Promise<void>;
  disconnect(sessionId: string): Promise<void>;
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
  pushEvent(event: string, value?: Readonly<Record<string, unknown>>): Promise<void>;
  retry(): void;
};
