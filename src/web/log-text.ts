/**
 * A step log as the run page shows it: text, never markup. A long log keeps only its last 1 MiB,
 * from the first whole line in it; bytes that are not UTF-8 become replacement characters; and
 * terminal escape sequences, carriage returns and other control characters are resolved the way
 * the README's "The run page" section says. Escaping for HTML is the renderer's job.
 */

/** The most of a log the page shows, from its end. */
export const LOG_LIMIT_BYTES = 1024 * 1024;

/**
 * How much of a log to read from its end: one byte more than the page shows, so it can tell
 * whether the first byte it shows begins a line.
 */
export const LOG_READ_BYTES = LOG_LIMIT_BYTES + 1;

const NEWLINE = 10; // "\n"
const CARRIAGE_RETURN = 13; // "\r"

/**
 * Terminal escape sequences, longest forms first: OSC (ended by BEL or ST), DCS, SOS, PM and APC
 * strings (ended by ST), CSI in its 7-bit and 8-bit forms, then any other escape with its
 * intermediate and final bytes. An unended string stops at the line's end, so one stray escape
 * cannot hide the rest of a log.
 */
const ESCAPE_SEQUENCE =
  // oxlint-disable-next-line no-control-regex -- the pattern is made of control characters
  /\u001B\][^\u0007\u001B\n]*(?:\u0007|\u001B\\)?|\u001B[PX^_][^\u001B\n]*(?:\u001B\\)?|\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B[ -/]*[0-~]/gu;

/** C0 and C1 control characters, but tab and newline, and DEL. */
// oxlint-disable-next-line no-control-regex -- the pattern is made of control characters
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

/**
 * A line as a terminal leaves it: carriage returns that end it dropped, then the text after the
 * last one. A loop, not a regular expression, so a long run of carriage returns stays linear.
 */
function settleCarriageReturns(line: string): string {
  let end = line.length;
  while (end > 0 && line.charCodeAt(end - 1) === CARRIAGE_RETURN) {
    end -= 1;
  }
  return end === 0 ? '' : line.slice(line.lastIndexOf('\r', end - 1) + 1, end);
}

/** `text` with escape sequences and control characters (but newline and tab) removed. */
export function cleanLogText(text: string): string {
  return text
    .replace(ESCAPE_SEQUENCE, '')
    .split('\n')
    .map(settleCarriageReturns)
    .join('\n')
    .replace(CONTROL_CHARACTER, '');
}

/** What the page shows of a log, and whether it was cut to its last 1 MiB. */
export type LogText = { readonly text: string; readonly cut: boolean };

/**
 * The text of a log read from byte `start` to its end, `LOG_READ_BYTES` at most. A log read whole
 * (`start` 0) is shown whole; a longer one from the first whole line in its last 1 MiB, or from the
 * start of that 1 MiB when it holds no line break with a line after it.
 */
export function logTextOf(bytes: Buffer, start: number): LogText {
  if (start === 0) {
    return { cut: false, text: cleanLogText(bytes.toString('utf8')) };
  }
  const newline = bytes.indexOf(NEWLINE);
  const startsLine = newline !== -1 && newline + 1 < bytes.length;
  const from = startsLine ? newline + 1 : Math.max(0, bytes.length - LOG_LIMIT_BYTES);
  return { cut: true, text: cleanLogText(bytes.subarray(from).toString('utf8')) };
}
