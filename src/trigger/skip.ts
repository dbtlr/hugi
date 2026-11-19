/**
 * GitHub's skip instructions (`Skipping workflow runs`). The bracket instructions are matched
 * case-sensitively, exactly as the documentation writes them: `[SKIP CI]` does not skip.
 */
const SKIP_PHRASES = ['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]'];

const SKIP_TRAILER = /^skip-checks: ?true$/u;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** A `Token: value` line, the token made of letters, digits and hyphens, as git reads one. */
const TRAILER_LINE = /^[A-Za-z0-9-]+[ \t]*:/u;

/**
 * A `skip-checks: true` trailer. It must be the last non-blank line of a trailer block, which
 * follows git (`git interpret-trailers --parse`): the final paragraph, after the last blank or
 * whitespace-only line, is a trailer block only when every line in it is a trailer line or a
 * continuation line (starting with whitespace). GitHub's documentation asks for "two empty
 * lines" before the trailer; that is read as a blank-line separator, so one or more blank lines
 * are accepted, as git accepts them. The block cannot be the message's first paragraph.
 */
function hasSkipTrailer(message: string): boolean {
  const lines = message.replaceAll('\r\n', '\n').split('\n');
  while (lines.length > 0 && isBlank(lines.at(-1)!)) {
    lines.pop();
  }
  if (lines.length === 0 || !SKIP_TRAILER.test(lines.at(-1)!.trimEnd())) {
    return false;
  }
  const lastBlank = lines.findLastIndex(isBlank);
  const block = lines.slice(lastBlank + 1);
  if (lastBlank === -1 || lines.slice(0, lastBlank).every(isBlank)) {
    return false;
  }
  return block.every((line) => TRAILER_LINE.test(line) || /^[ \t]/u.test(line));
}

/** Whether a commit message carries one of GitHub's skip instructions. */
export function skipsWorkflows(message: string): boolean {
  return SKIP_PHRASES.some((phrase) => message.includes(phrase)) || hasSkipTrailer(message);
}
