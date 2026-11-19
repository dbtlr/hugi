/**
 * Hugi's strict YAML reader, for files Hugi owns the meaning of (the lane declaration and Hugi's
 * configuration). It reads the YAML 1.2 core schema, so `yes` and `no` stay strings, and it
 * refuses the features that make a file mean something other than what it says: directives,
 * duplicate keys, merge keys, anchors, aliases, and explicit tags. Workflow files are not read
 * with it, because GitHub's own reader is more lenient.
 */
import { LineCounter, Parser, isAlias, isNode, isScalar, parseDocument, visit } from 'yaml';
import type { Node, YAMLMap } from 'yaml';

import { messageOf } from '../errors';

/** A parsed value that is a mapping: an object that is not null and not a list. */
export function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text is not YAML Hugi accepts; the message names the problem and its line and column. */
export class YamlRefusalError extends Error {
  override readonly name = 'YamlRefusalError';
}

function locate(lines: LineCounter, offset: number): string {
  const { col, line } = lines.linePos(offset);
  return `line ${line}, column ${col}`;
}

function refuse(problem: string, lines: LineCounter, offset: number): never {
  throw new YamlRefusalError(`${problem} at ${locate(lines, offset)}`);
}

/** The offset of the first YAML directive (`%YAML`, `%TAG`) before a document, if any. */
function directiveOffset(text: string): number | undefined {
  for (const token of new Parser().parse(text)) {
    if (token.type === 'directive') {
      return token.offset;
    }
  }
  return undefined;
}

/** The first offset of a node the strict reader refuses, with the problem it names. */
function refuseNode(node: Node, lines: LineCounter) {
  const offset = node.range?.[0] ?? 0;
  if (isAlias(node)) {
    refuse('YAML aliases are not allowed', lines, offset);
  }
  if (node.anchor !== undefined) {
    refuse(`YAML anchors are not allowed (&${node.anchor})`, lines, offset);
  }
  if (node.tag !== undefined) {
    refuse(`explicit YAML tags are not allowed (${node.tag})`, lines, offset);
  }
}

/**
 * Refuse a collection key, and a key whose text form repeats in its mapping: `1` and `"1"` are
 * different YAML keys but one JS property, so the later would silently replace the earlier.
 */
function refuseCollidingKeys(map: YAMLMap, lines: LineCounter) {
  const seen = new Set<string>();
  for (const { key } of map.items) {
    const offset = isNode(key) ? (key.range?.[0] ?? 0) : 0;
    // An alias, anchor or tag on the key is refused for what it is, before its shape is judged.
    if (isNode(key)) {
      refuseNode(key, lines);
    }
    if (!isScalar(key)) {
      refuse('a mapping key must be a scalar, not a collection', lines, offset);
    }
    // A null key is the empty property name, as the reader turns it into one.
    const { value } = key;
    const name =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '';
    if (seen.has(name)) {
      refuse('the key repeats another key of its mapping, read as text', lines, offset);
    }
    seen.add(name);
  }
}

/**
 * Parse `text` as one YAML 1.2 document of plain values. Throws a `YamlRefusalError` for malformed
 * YAML and for the refused features above. An empty text reads as `null`.
 */
export function parseStrictYaml(text: string): unknown {
  const lines = new LineCounter();
  const document = parseDocument(text, {
    lineCounter: lines,
    merge: false,
    schema: 'core',
    uniqueKeys: true,
    version: '1.2',
  });
  const [problem] = document.errors;
  if (problem !== undefined) {
    const [start] = problem.pos;
    refuse(
      messageOf(problem)
        .split('\n')[0]!
        .replace(/ at line \d+, column \d+:?$/u, ''),
      lines,
      start,
    );
  }
  const directive = directiveOffset(text);
  if (directive !== undefined) {
    refuse('YAML directives are not allowed', lines, directive);
  }
  visit(document, {
    // A specific visitor replaces the generic Node one, so a mapping gets both checks here.
    Map: (_key, map) => {
      refuseNode(map, lines);
      refuseCollidingKeys(map, lines);
    },
    Node: (_key, node) => {
      refuseNode(node, lines);
    },
    Pair: (_key, pair) => {
      if (isScalar(pair.key) && pair.key.value === '<<') {
        refuse('YAML merge keys (<<) are not allowed', lines, pair.key.range?.[0] ?? 0);
      }
    },
  });
  return document.toJS();
}
