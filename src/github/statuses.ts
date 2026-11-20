/**
 * Posts Hugi's verdicts to GitHub as commit statuses: one per lane, `pending` when its run
 * starts and then `success` or `failure`, and one `failure` named `hugi` for a refused
 * declaration. A pull request's statuses go on its head commit (ADR-0005), and the description
 * records the merge commit that was tested so shadow can tell base drift from a real mismatch.
 */
import { messageOf } from '../errors';
import type { LaneRef } from '../lane/step-plan';
import { GitHubAppError } from './app-auth';
import type { TokenProvider } from './client';
import { FULL_SHA } from './pull-request';
import type { Fetch } from './pull-request';
import { requestJson } from './request';
import type { FailureDetail } from './request';
import { DECLARATION_STATUS, laneStatusName, withoutNonBmp } from './status-name';

/**
 * A status could not be posted. Names the repository and the endpoint. The caller decides what to
 * retry, from `status` (GitHub's HTTP status, absent when GitHub gave no answer or no token could
 * be had) and `cause`: no status, 5xx and 429 may pass on a later try; 401 from the status post
 * means the cached token was revoked, and the reporter has already dropped it, so one more try
 * mints a fresh one, while a 401 from minting the token (GitHub refused the App's JWT, a `cause`
 * that is a `GitHubAppError`) will fail the same way again; 403,
 * 404 and 422 will not pass until the App's permissions, the installation or the data change.
 */
export class StatusPostError extends Error {
  override readonly name = 'StatusPostError';
  /** `owner/name`. */
  readonly repository: string;
  /** The method and path posted, such as `POST /repos/owner/name/statuses/<sha>`. */
  readonly endpoint: string;
  /** GitHub's HTTP status, when GitHub answered. */
  readonly status: number | undefined;

  constructor(repository: string, endpoint: string, message: string, detail: FailureDetail = {}) {
    super(message, 'cause' in detail ? { cause: detail.cause } : undefined);
    this.repository = repository;
    this.endpoint = endpoint;
    this.status = detail.status;
  }
}

/** The states Hugi posts. `error` is not among them: Hugi gives a lane no verdict instead. */
export type PostedState = 'pending' | 'success' | 'failure';

/** GitHub rejects a longer status description. */
export const DESCRIPTION_LIMIT = 140;

/** How many characters of a merge commit sha a description records. */
const MERGE_SHA_LENGTH = 12;

const HEADLINES: Readonly<Record<PostedState, string>> = {
  failure: 'Failed',
  pending: 'Running',
  success: 'Passed',
};

/** What a description is built from. */
export type DescriptionParts = {
  readonly state: PostedState;
  /** Why, for a failure whose cause is worth naming; shortened to fit. */
  readonly cause?: string;
  /** The merge commit a pull request's lane ran on. */
  readonly mergeSha?: string;
  /** Replaces the state's headline, for a status that is not a lane's verdict. */
  readonly headline?: string;
};

/** The longest headline; with the merge part and `: ` this leaves the cause room to spare. */
const HEADLINE_LIMIT = 40;

/**
 * `text` cut to `max` characters, with an ellipsis when it was cut. It holds no character outside
 * the BMP (see `describeStatus`), so a character is one UTF-16 unit and no surrogate pair splits.
 */
function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The one place status descriptions are built: `<headline>[: <cause>][ (merge <sha>)]`, at most
 * `DESCRIPTION_LIMIT` characters. GitHub refuses a character outside the BMP in a description, so
 * each one becomes U+FFFD first, which also makes a character count the same as a UTF-16 unit.
 * The headline is capped at `HEADLINE_LIMIT`; the cause is whitespace-collapsed and gives way
 * first, so the merge sha is always kept.
 */
export function describeStatus(parts: DescriptionParts): string {
  const headline = shorten(withoutNonBmp(parts.headline ?? HEADLINES[parts.state]), HEADLINE_LIMIT);
  const merge =
    parts.mergeSha === undefined ? '' : ` (merge ${parts.mergeSha.slice(0, MERGE_SHA_LENGTH)})`;
  const cause = withoutNonBmp(parts.cause ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cause === '') {
    return `${headline}${merge}`;
  }
  const room = DESCRIPTION_LIMIT - headline.length - merge.length - 2;
  return `${headline}: ${shorten(cause, room)}${merge}`;
}

/** The commit a status lands on and, for a pull request, the merge commit that was tested. */
export type StatusTarget = {
  /** `owner/name`. */
  readonly repository: string;
  /** The default branch head, or the pull request's head commit. */
  readonly sha: string;
  /** Set for a pull request's lane: the merge commit the lane ran on. */
  readonly mergeSha?: string;
};

export type LaneStatus = {
  readonly state: PostedState;
  /** Why a lane failed, when known. */
  readonly cause?: string;
  /** A link to the run's logs, when there is one. */
  readonly targetUrl?: string;
};

export type StatusReporter = {
  /** Post a lane's status under `laneStatusName(lane)`. */
  readonly reportLane: (target: StatusTarget, lane: LaneRef, status: LaneStatus) => Promise<void>;
  /** Post the one `failure` named `hugi` that says a commit's lane declaration was refused. */
  readonly reportRefusal: (target: StatusTarget, cause: string) => Promise<void>;
};

export type StatusReporterOptions = {
  readonly fetch: Fetch;
  /** The token provider for a repository, such as `createInstallationTokens(...)`. */
  readonly token: (repository: string) => TokenProvider;
  /** Drops a repository's cached token; called when GitHub answers a post 401. */
  readonly invalidate: (repository: string) => void;
  /** How long each request may take. */
  readonly timeoutMs?: number;
};

/** A status as GitHub's API takes it. */
type StatusBody = {
  readonly state: PostedState;
  readonly context: string;
  readonly description: string;
  readonly target_url?: string;
};

export function createStatusReporter(options: StatusReporterOptions): StatusReporter {
  const post = async (target: StatusTarget, body: StatusBody): Promise<void> => {
    const { repository, sha } = target;
    const path = `/repos/${repository}/statuses/${sha}`;
    const endpoint = `POST ${path}`;
    const fail = (message: string, detail?: FailureDetail) =>
      new StatusPostError(repository, endpoint, message, detail);
    if (!FULL_SHA.test(sha)) {
      throw fail(`Cannot post a status for ${endpoint}: "${sha}" is not a full commit sha.`);
    }
    let bearer: string;
    try {
      bearer = await options.token(repository)();
    } catch (error) {
      throw fail(`Cannot get a GitHub token for ${endpoint}: ${messageOf(error)}`, {
        cause: error,
        ...(error instanceof GitHubAppError && error.status !== undefined
          ? { status: error.status }
          : {}),
      });
    }
    try {
      await requestJson({
        bearer,
        body,
        fail,
        fetch: options.fetch,
        method: 'POST',
        path,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    } catch (error) {
      if (error instanceof StatusPostError && error.status === 401) {
        options.invalidate(repository);
      }
      throw error;
    }
  };

  return {
    reportLane: (target, lane, status) =>
      post(target, {
        context: laneStatusName(lane),
        description: describeStatus({
          state: status.state,
          ...(status.cause === undefined ? {} : { cause: status.cause }),
          ...(target.mergeSha === undefined ? {} : { mergeSha: target.mergeSha }),
        }),
        state: status.state,
        ...(status.targetUrl === undefined ? {} : { target_url: status.targetUrl }),
      }),
    reportRefusal: (target, cause) =>
      post(target, {
        context: DECLARATION_STATUS,
        description: describeStatus({
          cause,
          headline: 'Declaration refused',
          state: 'failure',
          ...(target.mergeSha === undefined ? {} : { mergeSha: target.mergeSha }),
        }),
        state: 'failure',
      }),
  };
}
