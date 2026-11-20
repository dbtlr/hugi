/**
 * One authenticated write-side request to GitHub's API: bounded by a time limit, its failures
 * reported through the caller's error type so each caller names its own repository and endpoint.
 */
import { messageOf } from '../errors';
import { isMapping } from '../yaml/strict';
import { API_HEADERS, READ_TIMEOUT_MS } from './pull-request';
import type { Fetch } from './pull-request';

export const API = 'https://api.github.com';

export type RequestSpec = {
  readonly fetch: Fetch;
  readonly method: 'GET' | 'POST';
  /** The path under the API root, such as `/repos/owner/name/installation`. */
  readonly path: string;
  /** The whole `Authorization` value after `Bearer `. */
  readonly bearer: string;
  readonly body?: unknown;
  /** How long the request may take, its body included. */
  readonly timeoutMs?: number;
  /**
   * Makes the caller's typed error from a message that already names the endpoint. `status` is
   * GitHub's HTTP status when it answered, and `cause` the error underneath, when there was one.
   */
  readonly fail: (message: string, detail?: FailureDetail) => Error;
};

/** What a caller's typed error carries besides its message. */
export type FailureDetail = { readonly status?: number; readonly cause?: unknown };

/** GitHub's own explanation, when its error body has one; empty otherwise. */
async function explanationOf(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    return isMapping(body) && typeof body.message === 'string'
      ? ` (${body.message.slice(0, 200)})`
      : '';
  } catch {
    return '';
  }
}

/** The parsed JSON of a 2xx answer; anything else is the caller's error. */
export async function requestJson(spec: RequestSpec): Promise<unknown> {
  const { bearer, fail, method, path } = spec;
  const endpoint = `${method} ${path}`;
  const timeoutMs = spec.timeoutMs ?? READ_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = () =>
    fail(`GitHub's API did not answer within ${timeoutMs / 1000} s for ${endpoint}.`);
  let response: Response;
  try {
    response = await spec.fetch(`${API}${path}`, {
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      headers: {
        ...API_HEADERS,
        Authorization: `Bearer ${bearer}`,
        ...(spec.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      method,
      signal,
    });
  } catch (error) {
    throw signal.aborted
      ? timedOut()
      : fail(`Cannot reach GitHub's API for ${endpoint}: ${messageOf(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw fail(
      `GitHub's API answered ${response.status} for ${endpoint}${await explanationOf(response)}.`,
      { status: response.status },
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw signal.aborted
      ? timedOut()
      : fail(`GitHub's answer for ${endpoint} is malformed: ${messageOf(error)}.`, {
          cause: error,
          status: response.status,
        });
  }
}
