/**
 * How the lane reader fails. A `LaneReadError` is about the workflow: content Hugi cannot read,
 * which is a fail verdict. A `LaneSelectionError` is about the caller's choice of lane: a job,
 * matrix values, or upstream values that pick no lane that runs, which is a usage error.
 */
import { messageOf } from '../errors';

export class LaneReadError extends Error {
  override readonly name: string = 'LaneReadError';
}

/**
 * The caller's selection picks no runnable lane: the job is missing, the matrix values select no
 * single combination, an upstream value is missing, or `needs` names a job the lane does not need.
 */
export class LaneSelectionError extends LaneReadError {
  override readonly name: string = 'LaneSelectionError';
}

/** The job's own `if:` is false for this event, so GitHub skips it and there is nothing to judge. */
export class JobSkippedError extends LaneSelectionError {
  override readonly name = 'JobSkippedError';
}

/**
 * `cause` with `prefix` added to its message, keeping a selection error's class so it survives
 * every layer of context the reader adds.
 */
export function withContext(
  prefix: string,
  cause: unknown,
  Fallback: new (message: string, options: ErrorOptions) => Error = Error,
): Error {
  const message = `${prefix}: ${messageOf(cause)}`;
  if (cause instanceof JobSkippedError) {
    return new JobSkippedError(message, { cause });
  }
  if (cause instanceof LaneSelectionError) {
    return new LaneSelectionError(message, { cause });
  }
  return new Fallback(message, { cause });
}
