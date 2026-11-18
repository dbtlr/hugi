/** The text of a caught value: an Error's message, else its string form. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
