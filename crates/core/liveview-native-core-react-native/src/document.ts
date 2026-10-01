import type { LiveViewDocument, LiveViewNode } from './types';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Validate a complete atomic Rust snapshot before making it visible to React. */
export function parseDocument(json: string): LiveViewDocument {
  const input: unknown = JSON.parse(json);
  if (!isObject(input) || !isId(input.root) || !Array.isArray(input.nodes)) {
    throw new Error('Invalid LiveView document envelope');
  }
  const nodes = new Map<number, LiveViewNode>();
  for (const inputNode of input.nodes) {
    if (
      !isObject(inputNode) || !isId(inputNode.id) ||
      !['root', 'element', 'text'].includes(String(inputNode.kind)) ||
      !Array.isArray(inputNode.children) || !inputNode.children.every(isId)
    ) {
      throw new Error('Invalid LiveView node');
    }
    if (nodes.has(inputNode.id)) throw new Error(`Duplicate LiveView node ${inputNode.id}`);
    if (inputNode.kind === 'element' && typeof inputNode.tag !== 'string') {
      throw new Error('LiveView element is missing its tag');
    }
    if (inputNode.kind === 'text' && (
      typeof inputNode.text !== 'string' || inputNode.children.length > 0
    )) {
      throw new Error('Invalid LiveView text node');
    }
    let attributes: Readonly<Record<string, string | null>> | undefined;
    if (inputNode.attributes !== undefined) {
      if (!isObject(inputNode.attributes) ||
        Object.values(inputNode.attributes).some(value => value !== null && typeof value !== 'string')) {
        throw new Error('Invalid LiveView attributes');
      }
      attributes = Object.freeze({ ...inputNode.attributes }) as Readonly<Record<string, string | null>>;
    }
    nodes.set(inputNode.id, Object.freeze({
      id: inputNode.id,
      kind: inputNode.kind as LiveViewNode['kind'],
      tag: inputNode.tag as string | undefined,
      attributes,
      text: inputNode.text as string | undefined,
      children: Object.freeze([...inputNode.children]),
    }));
  }
  if (nodes.get(input.root)?.kind !== 'root') throw new Error('LiveView root is missing');
  // Iterative traversal rejects cycles and shared children without recursive parsing.
  const visited = new Set<number>();
  const pending: number[] = [input.root];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) throw new Error('LiveView document is not a tree');
    visited.add(id);
    const node = nodes.get(id);
    if (!node) throw new Error(`Missing LiveView child ${id}`);
    if (id !== input.root && node.kind === 'root') throw new Error('Nested LiveView root');
    pending.push(...node.children);
  }
  if (visited.size !== nodes.size) throw new Error('Unreachable LiveView node');
  return Object.freeze({ root: input.root, nodes });
}
