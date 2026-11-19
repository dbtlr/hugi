/**
 * Reads one pull request from GitHub's API, unauthenticated: the facts ADR-0005 checks before a
 * pull request runs on its merge commit. GitHub's API is the authority on whether the merge ref is
 * current, since GitHub leaves a stale merge ref in place after a conflict or a close.
 */
import { messageOf } from '../errors';

/** The facts Hugi reads from GitHub's single-pull-request endpoint. */
export type PullRequestFacts = {
  readonly number: number;
  readonly state: 'open' | 'closed';
  /** `null` while GitHub computes the merge, `false` on a conflict. */
  readonly mergeable: boolean | null;
  /** The current merge commit, or `null` when there is none. */
  readonly mergeCommitSha: string | null;
  readonly headSha: string;
  /** The head branch's name, without the fork owner (the API's `head.ref`, not `head.label`). */
  readonly headRef: string;
  readonly baseRef: string;
};

/** The one network call this module makes; production passes the runtime's `fetch`. */
export type Fetch = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => Promise<Response>;

/** GitHub could not tell Hugi about the pull request: it does not exist, or the read failed. */
export class PullRequestReadError extends Error {
  override readonly name = 'PullRequestReadError';
}

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'hugi',
  'X-GitHub-Api-Version': '2022-11-28',
} as const;

const FULL_SHA = /^[0-9a-f]{40}$/u;

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The facts in `body`, or a description of the first field that is not what GitHub documents. */
function factsOf(body: unknown, number: number): PullRequestFacts | string {
  if (!isObject(body) || !isObject(body.head) || !isObject(body.base)) {
    return 'it has no head or base';
  }
  const { base, head, merge_commit_sha: mergeCommitSha, mergeable, state } = body;
  if (body.number !== number) {
    return `it describes pull request ${String(body.number)}`;
  }
  if (state !== 'open' && state !== 'closed') {
    return `its state is ${JSON.stringify(state)}`;
  }
  if (mergeable !== null && typeof mergeable !== 'boolean') {
    return 'its mergeable is not true, false, or null';
  }
  if (
    mergeCommitSha !== null &&
    (typeof mergeCommitSha !== 'string' || !FULL_SHA.test(mergeCommitSha))
  ) {
    return 'its merge_commit_sha is not a full sha or null';
  }
  if (typeof head.sha !== 'string' || !FULL_SHA.test(head.sha)) {
    return 'its head.sha is not a full sha';
  }
  if (
    typeof head.ref !== 'string' ||
    head.ref === '' ||
    typeof base.ref !== 'string' ||
    base.ref === ''
  ) {
    return 'its head.ref or base.ref is not a branch name';
  }
  return {
    baseRef: base.ref,
    headRef: head.ref,
    headSha: head.sha,
    mergeCommitSha,
    mergeable,
    number,
    state,
  };
}

/** Why a non-2xx answer failed the read. */
function statusFailure(status: number, repository: string, number: number): string {
  if (status === 404) {
    return `The pull request ${number} does not exist in ${repository}, or the repository is not public.`;
  }
  if (status === 403 || status === 429) {
    return `GitHub's anonymous rate limit of 60 requests an hour is used up (status ${status}); try again later.`;
  }
  return `GitHub's API answered ${status} for pull request ${number} in ${repository}.`;
}

/**
 * Read pull request `number` of the `owner/name` repository. Every failure, from the network to a
 * body that is not what GitHub documents, throws `PullRequestReadError` naming the cause.
 */
export async function readPullRequest(
  repository: string,
  number: number,
  fetch: Fetch,
): Promise<PullRequestFacts> {
  const url = `https://api.github.com/repos/${repository}/pulls/${number}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: HEADERS });
  } catch (error) {
    throw new PullRequestReadError(`Cannot reach GitHub's API: ${messageOf(error)}`);
  }
  if (!response.ok) {
    throw new PullRequestReadError(statusFailure(response.status, repository, number));
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new PullRequestReadError(
      `GitHub's answer for pull request ${number} is malformed: ${messageOf(error)}`,
    );
  }
  const facts = factsOf(body, number);
  if (typeof facts === 'string') {
    throw new PullRequestReadError(
      `GitHub's answer for pull request ${number} is malformed: ${facts}.`,
    );
  }
  return facts;
}
