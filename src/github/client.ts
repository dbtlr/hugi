/**
 * Reads what the poller needs from GitHub's REST API with an installation token: a repository's
 * default branch head with its message, its open pull requests, one pull request's merge facts,
 * and a commit's statuses. Every read is bounded by a time limit, and every failure is one
 * `GitHubReadError` naming the repository and the endpoint.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { messageOf } from '../errors';
import { isMapping } from '../yaml/strict';
import { API_HEADERS, FULL_SHA, factsOf, READ_TIMEOUT_MS } from './pull-request';
import type { Fetch, PullRequestFacts } from './pull-request';

/** Supplies the token each read sends; minting an installation token is the caller's. */
export type TokenProvider = () => Promise<string>;

/**
 * A read from GitHub's API failed. The poller skips what was being read for this poll: the
 * repository for a repository-level read (the repository, its default branch, or its open pull
 * requests), only the default branch head for a read of that head's statuses, and only the pull
 * request for a read of one pull request or its head's statuses.
 */
export class GitHubReadError extends Error {
  override readonly name = 'GitHubReadError';
  /** `owner/name`. */
  readonly repository: string;
  /** The method and path read, such as `GET /repos/owner/name/pulls`. */
  readonly endpoint: string;

  constructor(repository: string, endpoint: string, message: string) {
    super(message);
    this.repository = repository;
    this.endpoint = endpoint;
  }
}

/** A commit status's state as GitHub reports it; only the first three are verdicts. */
export type CommitStatusState = 'success' | 'failure' | 'error' | 'pending';

/** The tip of a repository's default branch. */
export type BranchHead = {
  readonly branch: string;
  readonly sha: string;
  readonly message: string;
};

/** An open pull request as the listing reports it; the listing lacks the merge facts. */
export type OpenPullRequest = {
  readonly number: number;
  /** `null` when the author's account is gone. */
  readonly authorLogin: string | null;
  readonly headSha: string;
  /** The head branch's name, without the fork owner. */
  readonly headRef: string;
  readonly baseRef: string;
};

export type GitHubReader = {
  readonly defaultBranchHead: (repository: string) => Promise<BranchHead>;
  readonly openPullRequests: (repository: string) => Promise<OpenPullRequest[]>;
  readonly pullRequest: (repository: string, number: number) => Promise<PullRequestFacts>;
  /** The latest state of each status context on the commit. */
  readonly commitStatuses: (
    repository: string,
    sha: string,
  ) => Promise<ReadonlyMap<string, CommitStatusState>>;
};

export type GitHubReaderOptions = {
  readonly fetch: Fetch;
  readonly token: TokenProvider;
  /** How long each request may take, its body included. */
  readonly timeoutMs?: number;
};

const API = 'https://api.github.com';

/** GitHub's largest page; a listing reads at most `MAX_PAGES` of them. */
const PER_PAGE = 100;

/** A Link header that never ends cannot hold a poll: 50 pages is 5000 entries. */
const MAX_PAGES = 50;

/** What the token's time limit resolves to when it runs out first. */
const EXPIRED = Symbol('expired');

const STATUS_STATES: readonly CommitStatusState[] = ['success', 'failure', 'error', 'pending'];

function isStatusState(value: unknown): value is CommitStatusState {
  return STATUS_STATES.some((state) => state === value);
}

/** Why a body is not what GitHub documents: the first field at fault. */
class Malformed {
  readonly detail: string;

  constructor(detail: string) {
    this.detail = detail;
  }
}

/** What one entry or body parses to, or why it is malformed. */
type Parsed<Value> = Value | Malformed;

/** The `rel="next"` URL of a Link header, if any. */
function nextLink(header: string | null): string | undefined {
  for (const part of header?.split(',') ?? []) {
    const match = /^\s*<([^>]*)>\s*;\s*rel="next"\s*$/u.exec(part);
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
}

/** One page's body, and the next page's URL when the listing continues. */
type Page = { readonly body: unknown; readonly next?: string };

/** One endpoint of one repository: every request it makes, and how a failure reads. */
class Endpoint {
  readonly #options: GitHubReaderOptions;
  readonly #repository: string;
  readonly #name: string;

  constructor(options: GitHubReaderOptions, repository: string, path: string) {
    this.#options = options;
    this.#repository = repository;
    this.#name = `GET ${path}`;
  }

  fail(message: string): GitHubReadError {
    return new GitHubReadError(this.#repository, this.#name, message);
  }

  malformed(detail: string): GitHubReadError {
    return this.fail(`GitHub's answer for ${this.#name} is malformed: ${detail}`);
  }

  get #timeoutMs(): number {
    return this.#options.timeoutMs ?? READ_TIMEOUT_MS;
  }

  /** The provider's token, bounded by the same time limit as a request, so it cannot hold a poll. */
  async #token(): Promise<string> {
    const timeoutMs = this.#timeoutMs;
    // Aborted once the race settles, so the timer stops; the race has already handled its rejection.
    const settled = new AbortController();
    let token: string | typeof EXPIRED;
    try {
      token = await Promise.race([
        this.#options.token(),
        sleep(timeoutMs, EXPIRED, { signal: settled.signal }),
      ]);
    } catch (error) {
      throw this.fail(`Cannot get a GitHub token for ${this.#name}: ${messageOf(error)}`);
    } finally {
      settled.abort();
    }
    if (token === EXPIRED) {
      throw this.fail(`Cannot get a GitHub token for ${this.#name} within ${timeoutMs / 1000} s.`);
    }
    return token;
  }

  /**
   * The error for an answer that is not 2xx. A 403 or 429 is a rate limit when the token's
   * requests are used up, or when GitHub's secondary rate limit, which applies while requests
   * remain, asks the client to wait with `retry-after`.
   */
  #statusFailure(response: Response): GitHubReadError {
    const { status } = response;
    const remaining = response.headers.get('x-ratelimit-remaining');
    const retryAfter = response.headers.get('retry-after');
    if ((status === 403 || status === 429) && retryAfter !== null && remaining !== '0') {
      const wait = /^\d+$/u.test(retryAfter) ? `, retry after ${retryAfter} s` : '';
      return this.fail(
        `GitHub's secondary rate limit refused Hugi's GitHub installation token (status ${status}${wait}) at ${this.#name}; the repository is read again at a later poll.`,
      );
    }
    if (status === 429 || (status === 403 && remaining === '0')) {
      return this.fail(
        `The rate limit of Hugi's GitHub installation token is used up (status ${status}) at ${this.#name}; the repository is read again at a later poll.`,
      );
    }
    return this.fail(`GitHub's API answered ${status} for ${this.#name}.`);
  }

  /** Read one page at `url`; a timeout covers the answer and its body. */
  async page(url: string): Promise<Page> {
    const token = await this.#token();
    const timeoutMs = this.#timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    const timedOut = () =>
      this.fail(`GitHub's API did not answer within ${timeoutMs / 1000} s for ${this.#name}.`);
    let response: Response;
    try {
      response = await this.#options.fetch(url, {
        headers: { ...API_HEADERS, Authorization: `Bearer ${token}` },
        signal,
      });
    } catch (error) {
      throw signal.aborted
        ? timedOut()
        : this.fail(`Cannot reach GitHub's API for ${this.#name}: ${messageOf(error)}`);
    }
    if (!response.ok) {
      throw this.#statusFailure(response);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw signal.aborted ? timedOut() : this.malformed(messageOf(error));
    }
    const next = nextLink(response.headers.get('link'));
    if (next !== undefined && !next.startsWith(`${API}/`)) {
      // The token goes with every request, so a page off GitHub's API is never fetched.
      throw this.malformed('its next page is not on api.github.com');
    }
    return next === undefined ? { body } : { body, next };
  }

  /** Read the one body at `url` and parse it. */
  async read<Value>(url: string, parse: (body: unknown) => Parsed<Value>): Promise<Value> {
    const parsed = parse((await this.page(url)).body);
    if (parsed instanceof Malformed) {
      throw this.malformed(`${parsed.detail}.`);
    }
    return parsed;
  }

  /** Read every page from `url` on, following the Link header, and parse each page's entries. */
  async readAll<Value>(url: string, entries: (body: unknown) => Parsed<Value[]>): Promise<Value[]> {
    const all: Value[] = [];
    let next: string | undefined = url;
    for (let pages = 0; next !== undefined; pages += 1) {
      if (pages === MAX_PAGES) {
        throw this.fail(`${this.#name} lists more than ${MAX_PAGES} pages; Hugi reads no further.`);
      }
      // oxlint-disable-next-line no-await-in-loop -- each page names the next
      const page: Page = await this.page(next);
      const parsed = entries(page.body);
      if (parsed instanceof Malformed) {
        throw this.malformed(`${parsed.detail}.`);
      }
      all.push(...parsed);
      ({ next } = page);
    }
    return all;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function defaultBranchOf(body: unknown): Parsed<string> {
  if (!isMapping(body) || !nonEmptyString(body.default_branch)) {
    return new Malformed('it has no default_branch');
  }
  return body.default_branch;
}

function branchHeadOf(body: unknown, branch: string): Parsed<BranchHead> {
  const commit = isMapping(body) ? body.commit : undefined;
  if (!isMapping(commit) || typeof commit.sha !== 'string' || !FULL_SHA.test(commit.sha)) {
    return new Malformed('its commit.sha is not a full sha');
  }
  if (!isMapping(commit.commit) || typeof commit.commit.message !== 'string') {
    return new Malformed('its commit.commit.message is not a string');
  }
  return { branch, message: commit.commit.message, sha: commit.sha };
}

/** A user's login, or `undefined` when the user has none. */
function loginOf(user: unknown): string | undefined {
  return isMapping(user) && nonEmptyString(user.login) ? user.login : undefined;
}

function pullRequestOf(entry: unknown): Parsed<OpenPullRequest> {
  if (!isMapping(entry) || !isMapping(entry.head) || !isMapping(entry.base)) {
    return new Malformed('a pull request has no head or base');
  }
  const { base, head, number, user } = entry;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    return new Malformed('a pull request has no positive number');
  }
  const authorLogin = user === null ? null : loginOf(user);
  if (authorLogin === undefined) {
    return new Malformed(`pull request ${number}'s user is neither null nor a login`);
  }
  if (typeof head.sha !== 'string' || !FULL_SHA.test(head.sha)) {
    return new Malformed(`pull request ${number}'s head.sha is not a full sha`);
  }
  if (!nonEmptyString(head.ref) || !nonEmptyString(base.ref)) {
    return new Malformed(`pull request ${number}'s head.ref or base.ref is not a branch name`);
  }
  return {
    authorLogin,
    baseRef: base.ref,
    headRef: head.ref,
    headSha: head.sha,
    number,
  };
}

/** Each entry of a page, or the first entry's problem. */
function eachOf<Value>(
  body: unknown,
  what: string,
  parse: (entry: unknown) => Parsed<Value>,
): Parsed<Value[]> {
  if (!Array.isArray(body)) {
    return new Malformed(`it is not a list of ${what}`);
  }
  const values: Value[] = [];
  for (const entry of body) {
    const parsed = parse(entry);
    if (parsed instanceof Malformed) {
      return parsed;
    }
    values.push(parsed);
  }
  return values;
}

type Status = { readonly context: string; readonly state: CommitStatusState };

function statusOf(entry: unknown): Parsed<Status> {
  if (!isMapping(entry) || !nonEmptyString(entry.context)) {
    return new Malformed('a status has no context');
  }
  if (!isStatusState(entry.state)) {
    return new Malformed(`status "${entry.context}" has the state ${JSON.stringify(entry.state)}`);
  }
  return { context: entry.context, state: entry.state };
}

/** A reader of GitHub's API that sends the provider's token with every request. */
export function createGitHubReader(options: GitHubReaderOptions): GitHubReader {
  const at = (repository: string, path: string) => {
    const full = `/repos/${repository}${path}`;
    return { endpoint: new Endpoint(options, repository, full), url: `${API}${full}` };
  };
  return {
    commitStatuses: async (repository, sha) => {
      const { endpoint, url } = at(repository, `/commits/${sha}/status`);
      const statuses = await endpoint.readAll(`${url}?per_page=${PER_PAGE}`, (body) =>
        isMapping(body)
          ? eachOf(body.statuses, 'statuses', statusOf)
          : new Malformed('it has no statuses'),
      );
      // The combined status holds one latest entry per context; a context listed twice keeps its first.
      const latest = new Map<string, CommitStatusState>();
      for (const { context, state } of statuses) {
        if (!latest.has(context)) {
          latest.set(context, state);
        }
      }
      return latest;
    },
    defaultBranchHead: async (repository) => {
      const repo = at(repository, '');
      const branch = await repo.endpoint.read(repo.url, defaultBranchOf);
      const head = at(repository, `/branches/${encodeURIComponent(branch)}`);
      return head.endpoint.read(head.url, (body) => branchHeadOf(body, branch));
    },
    openPullRequests: async (repository) => {
      const { endpoint, url } = at(repository, '/pulls');
      return endpoint.readAll(`${url}?state=open&per_page=${PER_PAGE}`, (body) =>
        eachOf(body, 'pull requests', pullRequestOf),
      );
    },
    pullRequest: async (repository, number) => {
      const { endpoint, url } = at(repository, `/pulls/${number}`);
      return endpoint.read(url, (body) => {
        const facts = factsOf(body, number);
        return typeof facts === 'string' ? new Malformed(facts) : facts;
      });
    },
  };
}
