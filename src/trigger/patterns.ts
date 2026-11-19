/**
 * GitHub's filter patterns (the "Filter pattern cheat sheet"): `*` matches within one path
 * segment, `**` matches anything, `?` and `+` quantify the preceding character, `[]` is a
 * character set, and `\` escapes. A pattern must match the whole name, case-sensitively.
 */

/** The regular expression source for one pattern. Each atom is grouped so a quantifier fits it. */
function patternSource(pattern: string): string {
  const atoms: string[] = [];
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` also matches no directory at all, so `**/README.md` matches `README.md`.
        const slash = pattern[index + 2] === '/';
        atoms.push(slash ? '(?:.*/)?' : '.*');
        index += slash ? 3 : 2;
      } else {
        atoms.push('[^/]*');
        index += 1;
      }
    } else if ((char === '?' || char === '+') && atoms.length > 0) {
      atoms.push(`(?:${atoms.pop()})${char}`);
      index += 1;
    } else if (char === '[' && pattern.includes(']', index + 2)) {
      const end = pattern.indexOf(']', index + 2);
      atoms.push(`[${pattern.slice(index + 1, end).replace(/[\\^]/gu, String.raw`\$&`)}]`);
      index = end + 1;
    } else if (char === '\\' && index + 1 < pattern.length) {
      atoms.push(escapeLiteral(pattern[index + 1]!));
      index += 2;
    } else {
      atoms.push(escapeLiteral(char));
      index += 1;
    }
  }
  return atoms.map((atom) => `(?:${atom})`).join('');
}

function escapeLiteral(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\/-]/gu, String.raw`\$&`);
}

/** Whether one pattern, without any leading `!`, matches the whole name. */
export function matchesPattern(pattern: string, name: string): boolean {
  return new RegExp(`^${patternSource(pattern)}$`, 'su').test(name);
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
