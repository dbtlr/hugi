/** What `messageOf` gives for a value that cannot be turned into text. */
const UNDESCRIBABLE = 'an error that cannot be described';

/**
 * The text of a caught value: an Error's message, else its string form. It never throws, so a
 * handler that describes what it caught cannot fail itself: a value whose string form throws,
 * such as `Object.create(null)`, gives a fixed text.
 */
export function messageOf(error: unknown): string {
  try {
    const text: unknown = error instanceof Error ? error.message : error;
    return typeof text === 'string' ? text : String(text);
  } catch {
    return UNDESCRIBABLE;
  }
}
