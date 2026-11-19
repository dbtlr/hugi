/**
 * GitHub's skip instructions (`Skipping workflow runs`). They are matched case-sensitively, as
 * the documentation writes them.
 */
const SKIP_PHRASES = ['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]'];

const SKIP_TRAILER = /^skip-checks: ?true$/u;

/** A `skip-checks: true` line in the message's last paragraph, which must follow a body. */
function hasSkipTrailer(message: string): boolean {
  const paragraphs = message
    .replaceAll('\r\n', '\n')
    .trimEnd()
    .split(/\n[ \t]*\n/u);
  if (paragraphs.length < 2) {
    return false;
  }
  return paragraphs
    .at(-1)!
    .split('\n')
    .some((line) => SKIP_TRAILER.test(line.trimEnd()));
}

/** Whether a commit message carries one of GitHub's skip instructions. */
export function skipsWorkflows(message: string): boolean {
  return SKIP_PHRASES.some((phrase) => message.includes(phrase)) || hasSkipTrailer(message);
}
