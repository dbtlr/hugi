/**
 * GitHub's filter patterns (the "Filter pattern cheat sheet"): `*` matches within one path
 * segment, `**` matches anything, `?` and `+` quantify the preceding character, `[]` is a set of
 * alphanumeric characters and ranges, and `\` escapes. A pattern must match the whole name,
 * case-sensitively. Patterns and names are read by code point.
 *
 * Patterns come from the repository, so matching never backtracks: it tracks the set of name
 * positions each atom can reach, which bounds the work at pattern atoms times name length.
 */
import { TriggerError } from './errors';

/** What one atom matches before its quantifiers apply. */
type Base =
  | { readonly kind: 'char'; readonly char: string }
  | { readonly kind: 'class'; readonly ranges: readonly (readonly [number, number])[] }
  /** `*`: any run of characters other than `/`. */
  | { readonly kind: 'star' }
  /** `**`: any run of characters. */
  | { readonly kind: 'globstar' }
  // `**` then `/`: nothing, or any run of characters ending in `/`, so `**/a` matches `a`.
  | { readonly kind: 'dirs' };

type Atom = { readonly base: Base; optional: boolean; repeated: boolean };

/** A parsed pattern, ready to match names. */
export type Pattern = readonly Atom[];

/** A string's code points. Patterns and names are compared by code point, not UTF-16 unit. */
function codePoints(text: string): string[] {
  // oxlint-disable-next-line typescript/no-misused-spread -- code points are the intended unit
  return [...text];
}

/** The ranges a class may use: `a-z`, `A-Z`, and `0-9`. */
const CLASS_KINDS = [/^[a-z]$/u, /^[A-Z]$/u, /^[0-9]$/u];

function classKind(char: string): number {
  return CLASS_KINDS.findIndex((kind) => kind.test(char));
}

/** The ranges inside `[...]`, held to GitHub's grammar: alphanumerics and same-kind ranges. */
function classRanges(body: readonly string[]): [number, number][] {
  if (body.length === 0) {
    throw new TriggerError('a [] set must list at least one character');
  }
  const ranges: [number, number][] = [];
  let index = 0;
  while (index < body.length) {
    const first = body[index]!;
    if (classKind(first) < 0) {
      throw new TriggerError('a [] set may hold only letters, digits, and ranges of them');
    }
    if (body[index + 1] === '-') {
      const last = body[index + 2];
      if (last === undefined || classKind(last) !== classKind(first) || last < first) {
        throw new TriggerError('a [] range must run upward within a-z, A-Z, or 0-9');
      }
      ranges.push([first.codePointAt(0)!, last.codePointAt(0)!]);
      index += 3;
    } else {
      ranges.push([first.codePointAt(0)!, first.codePointAt(0)!]);
      index += 1;
    }
  }
  return ranges;
}

/** Parse one pattern, without any leading `!`, or throw a `TriggerError` GitHub would raise. */
export function parsePattern(pattern: string): Pattern {
  const chars = codePoints(pattern);
  const atoms: Atom[] = [];
  const push = (base: Base) => atoms.push({ base, optional: false, repeated: false });
  let index = 0;
  while (index < chars.length) {
    const char = chars[index]!;
    if (char === '*') {
      if (chars[index + 1] === '*') {
        const slash = chars[index + 2] === '/';
        push({ kind: slash ? 'dirs' : 'globstar' });
        index += slash ? 3 : 2;
      } else {
        push({ kind: 'star' });
        index += 1;
      }
    } else if ((char === '?' || char === '+') && atoms.length > 0) {
      // `?` makes the atom optional and `+` lets it repeat; either order gives zero or more.
      const atom = atoms.at(-1)!;
      atom.optional ||= char === '?';
      atom.repeated ||= char === '+';
      index += 1;
    } else if (char === '[') {
      const end = chars.indexOf(']', index + 1);
      if (end === -1) {
        throw new TriggerError('a [ has no closing ]');
      }
      push({ kind: 'class', ranges: classRanges(chars.slice(index + 1, end)) });
      index = end + 1;
    } else if (char === '\\' && index + 1 < chars.length) {
      push({ char: chars[index + 1]!, kind: 'char' });
      index += 2;
    } else {
      push({ char, kind: 'char' });
      index += 1;
    }
  }
  return atoms;
}

function matchesOne(base: Base & { kind: 'char' | 'class' }, char: string): boolean {
  if (base.kind === 'char') {
    return base.char === char;
  }
  const point = char.codePointAt(0)!;
  return base.ranges.some(([low, high]) => point >= low && point <= high);
}

/** The name positions reachable after `atom`, given those reachable before it. */
function step(atom: Atom, before: readonly boolean[], name: readonly string[]): boolean[] {
  const after = Array.from({ length: name.length + 1 }, () => false);
  const { base } = atom;
  if (base.kind === 'star' || base.kind === 'globstar') {
    // Quantifiers change nothing on a wildcard that already matches any run, the empty one too.
    for (let at = 0; at <= name.length; at += 1) {
      after[at] =
        before[at]! ||
        (at > 0 && after[at - 1]! && (base.kind === 'globstar' || name[at - 1] !== '/'));
    }
    return after;
  }
  if (base.kind === 'dirs') {
    let reached = false;
    for (let at = 0; at <= name.length; at += 1) {
      after[at] = before[at]! || (reached && name[at - 1] === '/');
      reached ||= before[at]!;
    }
    return after;
  }
  for (let at = 0; at < name.length; at += 1) {
    const from = before[at]! || (atom.repeated && after[at]!);
    if (from && matchesOne(base, name[at]!)) {
      after[at + 1] = true;
    }
  }
  if (atom.optional) {
    for (let at = 0; at <= name.length; at += 1) {
      after[at] ||= before[at]!;
    }
  }
  return after;
}

/** Whether a parsed pattern matches the whole name. */
function matchesParsed(pattern: Pattern, name: string): boolean {
  const chars = codePoints(name);
  let reachable = Array.from({ length: chars.length + 1 }, (_, at) => at === 0);
  for (const atom of pattern) {
    reachable = step(atom, reachable, chars);
    if (!reachable.includes(true)) {
      return false;
    }
  }
  return reachable[chars.length]!;
}

/** Whether one pattern, without any leading `!`, matches the whole name. */
export function matchesPattern(pattern: string, name: string): boolean {
  return matchesParsed(parsePattern(pattern), name);
}

/**
 * Whether a name is selected by a pattern list. Patterns apply in order: a match by a positive
 * pattern selects the name, a match by a `!` pattern deselects it, and a later pattern overrides
 * an earlier one.
 */
export function matchesPatterns(patterns: readonly string[], name: string): boolean {
  let selected = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (matchesPattern(pattern.slice(1), name)) {
        selected = false;
      }
    } else if (matchesPattern(pattern, name)) {
      selected = true;
    }
  }
  return selected;
}
