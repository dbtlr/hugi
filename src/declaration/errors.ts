/**
 * Why a lane declaration is refused. The message names the entry, job, or key at fault; the
 * reader turns it into the cause of a refused declaration.
 */
export class DeclarationRefusalError extends Error {
  override readonly name = 'DeclarationRefusalError';
}
