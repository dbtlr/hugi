/**
 * GitHub's skip instructions (`Skipping workflow runs`). The bracket instructions are matched
 * case-sensitively, exactly as the documentation writes them: `[SKIP CI]` does not skip.
 */
const SKIP_PHRASES = ['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]'];

const SKIP_TRAILER = /^skip-checks: ?true$/u;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/**
 * A `skip-checks: true` trailer. GitHub wants it at the end of the message, after the other
 * trailers, in a trailers paragraph set off by blank lines: it must be the last non-blank line,
 * and a blank line (whitespace-only counts) must separate its paragraph from the subject or body.
 */
function hasSkipTrailer(message: string): boolean {
  const lines = message.replaceAll('\r\n', '\n').split('\n');
  while (lines.length > 0 && isBlank(lines.at(-1)!)) {
    lines.pop();
  }
  if (lines.length === 0 || !SKIP_TRAILER.test(lines.at(-1)!.trimEnd())) {
    return false;
  }
  const firstText = lines.findIndex((line) => !isBlank(line));
  return lines.slice(firstText).some(isBlank);
}

/** Whether a commit message carries one of GitHub's skip instructions. */
export function skipsWorkflows(message: string): boolean {
  return SKIP_PHRASES.some((phrase) => message.includes(phrase)) || hasSkipTrailer(message);
}
