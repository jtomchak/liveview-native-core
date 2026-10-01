import type { LiveViewDocument, LiveViewNode } from './types';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 20_000;
const nodeBytes = new WeakMap<LiveViewNode, number>();
const MAX_DEPTH = 256;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function decode(json: string): unknown {
  if (json.length > MAX_BYTES || new TextEncoder().encode(json).length > MAX_BYTES) throw new Error('LiveView document exceeds byte limit');
  return JSON.parse(json);
}
function node(input: unknown): LiveViewNode {
  if (!isObject(input) || !isId(input.id) || !['root', 'element', 'text'].includes(String(input.kind)) ||
      !Array.isArray(input.children) || input.children.length > MAX_NODES || !input.children.every(isId)) throw new Error('Invalid LiveView node');
  if (input.kind === 'element' && typeof input.tag !== 'string') throw new Error('LiveView element is missing its tag');
  if (input.kind === 'text' && (typeof input.text !== 'string' || input.children.length > 0)) throw new Error('Invalid LiveView text node');
  let attributes: LiveViewNode['attributes'];
  if (input.attributes !== undefined) {
    if (!isObject(input.attributes) || Object.values(input.attributes).some(value => value !== null && typeof value !== 'string')) throw new Error('Invalid LiveView attributes');
    attributes = Object.freeze({ ...input.attributes }) as LiveViewNode['attributes'];
  }
  return Object.freeze({ id: input.id, kind: input.kind as LiveViewNode['kind'], tag: input.tag as string | undefined,
    attributes, text: input.text as string | undefined, children: Object.freeze([...input.children]) });
}
function equal(left: LiveViewNode, right: LiveViewNode) {
  if (left.kind !== right.kind || left.tag !== right.tag || left.text !== right.text || left.children.length !== right.children.length ||
      left.children.some((id, index) => id !== right.children[index])) return false;
  const a = left.attributes ?? {}, b = right.attributes ?? {};
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && a[key] === b[key]);
}
/** Final tree validation and ancestor versions happen before publishing an atomic document. */
function finish(root: number, nodes: Map<number, LiveViewNode>, previous?: LiveViewDocument): LiveViewDocument {
  if (nodes.size > MAX_NODES) throw new Error('LiveView document exceeds node limit');
  if (nodes.get(root)?.kind !== 'root') throw new Error('LiveView root is missing');
  const visited = new Set<number>(), parents = new Map<number, number>();
  const pending: [number, number][] = [[root, 0]], order: number[] = [];
  while (pending.length) {
    const [id, depth] = pending.pop()!;
    if (depth > MAX_DEPTH) throw new Error('LiveView document exceeds depth limit');
    if (visited.has(id)) throw new Error('LiveView document is not a tree');
    visited.add(id); order.push(id);
    const current = nodes.get(id);
    if (!current) throw new Error(`Missing LiveView child ${id}`);
    if (id !== root && current.kind === 'root') throw new Error('Nested LiveView root');
    for (const child of current.children) { parents.set(child, id); pending.push([child, depth + 1]); }
  }
  if (visited.size !== nodes.size) throw new Error('Unreachable LiveView node');
  let totalBytes = 32;
  for (const current of nodes.values()) {
    let bytes = nodeBytes.get(current);
    if (bytes === undefined) { bytes = new TextEncoder().encode(JSON.stringify(current)).length + 1; nodeBytes.set(current, bytes); }
    totalBytes += bytes;
    if (totalBytes > MAX_BYTES) throw new Error('LiveView document exceeds byte limit');
  }
  const affected = new Set<number>();
  for (const id of order) {
    if (nodes.get(id) === previous?.nodes.get(id)) continue;
    let ancestor: number | undefined = id;
    while (ancestor !== undefined && !affected.has(ancestor)) { affected.add(ancestor); ancestor = parents.get(ancestor); }
  }
  const subtreeVersions = new Map<number, number>();
  for (const id of order) subtreeVersions.set(id, (previous?.subtreeVersions?.get(id) ?? 0) + (affected.has(id) || !previous ? 1 : 0));
  return Object.freeze({ root, nodes, subtreeVersions });
}

/** Validate a complete atomic Rust snapshot; share equal nodes within one document generation. */
export function parseDocument(json: string, previous?: LiveViewDocument): LiveViewDocument {
  const input = decode(json);
  if (!isObject(input) || !isId(input.root) || !Array.isArray(input.nodes) || input.nodes.length > MAX_NODES) throw new Error('Invalid LiveView document envelope');
  const nodes = new Map<number, LiveViewNode>();
  for (const value of input.nodes) {
    const parsed = node(value);
    if (nodes.has(parsed.id)) throw new Error(`Duplicate LiveView node ${parsed.id}`);
    const old = previous?.nodes.get(parsed.id);
    nodes.set(parsed.id, old && equal(old, parsed) ? old : parsed);
  }
  return finish(input.root, nodes, previous);
}

/** Patches are applied to a private map and become visible only after complete validation. */
export function applyDocumentPatch(previous: LiveViewDocument, json: string, baseRevision: number, revision: number): LiveViewDocument {
  const input = decode(json);
  if (!isObject(input) || input.baseRevision !== baseRevision || input.revision !== revision ||
      !isId(revision) || revision <= baseRevision || !isId(input.root) ||
      !Array.isArray(input.upsert) || !Array.isArray(input.remove) ||
      input.upsert.length + input.remove.length > MAX_NODES * 2) throw new Error('Invalid LiveView patch envelope');
  const nodes = new Map(previous.nodes), operations = new Set<number>();
  for (const id of input.remove) {
    if (!isId(id) || operations.has(id) || !nodes.has(id)) throw new Error('Invalid LiveView patch removal');
    operations.add(id); nodes.delete(id);
  }
  for (const value of input.upsert) {
    const parsed = node(value);
    if (operations.has(parsed.id)) throw new Error('Duplicate LiveView patch operation');
    operations.add(parsed.id);
    const old = previous.nodes.get(parsed.id);
    nodes.set(parsed.id, old && equal(old, parsed) ? old : parsed);
  }
  return finish(input.root, nodes, previous);
}
