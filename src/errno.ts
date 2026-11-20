/** The system error code (`ENOENT`, `EEXIST`, ...) of a caught value, when it has one. */
export function errnoCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}
