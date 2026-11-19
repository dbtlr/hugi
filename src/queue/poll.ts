/**
 * One poll of GitHub's state (ADR-0004 "Events", ADR-0005): for each enrolled repository, read
 * its default branch head and the open pull requests the allowlist admits, and decide which
 * declared lanes each commit's event selects. The result is a snapshot that `deriveQueue` turns
 * into the queue; nothing is stored between polls.
 */
import type { HugiConfig } from '../config/schema';
import { readDeclaration } from '../declaration/read';
import type { CommitFiles } from '../declaration/read';
import { messageOf } from '../errors';
import { GitHubReadError } from '../github/client';
import type {
  BranchHead,
  CommitStatusState,
  GitHubReader,
  OpenPullRequest,
} from '../github/client';
import { pullRequestEvent, pullRequestRef } from '../github/pull-request';
import type { PullRequestFacts } from '../github/pull-request';
import { loadWorkflow } from '../lane/parse';
import { jobSelects } from '../lane/reader';
import type { EventContext, LaneRef } from '../lane/step-plan';
import { NoCurrentMergeError, NotAFileError, SourceError } from '../source/host-source';
import type { OpenedSource } from '../source/host-source';
import { skipsWorkflows, workflowStarts } from '../trigger';
import type { TriggerEvent } from '../trigger';
import { GUEST_RUNNER_PATHS } from '../vm';
import type {
  CommitRead,
  CommitSnapshot,
  CommitStatuses,
  LaneDecision,
  PullRequestReadFailure,
  ReadFailure,
  RepositorySnapshot,
  Snapshot,
} from './types';

/** The parts of a repository at one commit a poll reads: an opened `HostSource` is one. */
export type CommitSource = Pick<
  OpenedSource,
  'sha' | 'readFile' | 'changedFiles' | 'commitMessage'
>;

export type PollDeps = {
  readonly github: GitHubReader;
  /** The repository at a default branch head (`openHostSource` in production). */
  readonly openPush: (repository: string, sha: string) => Promise<CommitSource>;
  /**
   * The pull request at its merge commit once ADR-0005's five conditions hold
   * (`openPullRequestSource`); otherwise it throws `NoCurrentMergeError`.
   */
  readonly openPullRequest: (repository: string, facts: PullRequestFacts) => Promise<CommitSource>;
};

/** A commit's event, as the lane reader and the trigger each need it. */
type Considered = {
  readonly context: EventContext;
  readonly trigger: TriggerEvent;
};

/**
 * The source's files as the declaration reader takes them, each path read at most once for the
 * commit. A path that names a directory reads as absent: a workflow that is a directory refuses
 * the declaration as missing.
 */
function commitFiles(source: CommitSource): CommitFiles {
  const read = async (path: string) => {
    try {
      return (await source.readFile(path)) ?? null;
    } catch (error) {
      if (error instanceof NotAFileError) {
        return null;
      }
      throw error;
    }
  };
  const texts = new Map<string, Promise<string | null>>();
  return (path) => {
    let text = texts.get(path);
    if (text === undefined) {
      text = read(path);
      texts.set(path, text);
    }
    return text;
  };
}

/** `read`, called at most once however many path filters ask for it. */
function once(read: () => Promise<readonly string[]>): () => Promise<readonly string[]> {
  let pending: Promise<readonly string[]> | undefined;
  return () => {
    pending ??= read();
    return pending;
  };
}

/** A workflow file loaded once for a commit, with whether its `on:` starts it for the event. */
type ConsideredWorkflow = {
  readonly workflow: Record<string, unknown>;
  readonly starts: boolean;
} | null;

/**
 * Each workflow at the commit, loaded and its trigger decided once however many lanes it holds.
 * Its text is read once for the commit, through `commitFiles`, and parsed twice: by the
 * declaration reader, and once more here. A poll's cost so grows with the workflows' size plus the
 * lanes, not their product.
 */
function workflowsAt(files: CommitFiles, trigger: TriggerEvent) {
  const load = async (path: string): Promise<ConsideredWorkflow> => {
    const text = await files(path);
    if (text === null) {
      return null;
    }
    const workflow = loadWorkflow(text);
    return { starts: await workflowStarts(workflow.on, trigger), workflow };
  };
  const loaded = new Map<string, Promise<ConsideredWorkflow>>();
  return (path: string) => {
    let each = loaded.get(path);
    if (each === undefined) {
      each = load(path);
      loaded.set(path, each);
    }
    return each;
  };
}

/**
 * Whether the lane runs for the event: its workflow's `on:` must start it, then its job's `if:`
 * must hold. Only the `if:` is decided, not the lane's step plan, so a large job's many lanes stay
 * cheap. A lane the reader cannot otherwise read runs, so its run yields the fail verdict.
 *
 * An accepted declaration's workflows exist, loaded, and passed trigger validation, and this reads
 * the same file texts, so neither case below happens after an accepted declaration. A missing
 * workflow (`considered` is null) runs, as an unreadable lane does: the run reads the declaration
 * again and reports what it finds. A failure to load a workflow or read its `on:` throws an
 * unexpected error, which skips the commit's pull request, or the default branch head, for this
 * poll.
 */
function decideLane(
  lane: LaneRef,
  considered: ConsideredWorkflow,
  context: EventContext,
): LaneDecision {
  if (considered === null) {
    return { kind: 'runs', lane };
  }
  const runs =
    considered.starts && jobSelects(considered.workflow, lane, context, GUEST_RUNNER_PATHS);
  return { kind: runs ? 'runs' : 'left-out', lane };
}

const STATUS_STATES: ReadonlySet<unknown> = new Set<CommitStatusState>([
  'success',
  'failure',
  'error',
  'pending',
]);

function isStatusState(value: unknown): value is CommitStatusState {
  return STATUS_STATES.has(value);
}

/**
 * The statuses on `commit`, checked to be a map of context names to states and copied, so the
 * queue derived from them reads only plain, well-formed values. Anything else is the commit's
 * failed read, marked unexpected.
 */
async function readStatuses(
  github: GitHubReader,
  repository: string,
  commit: string,
): Promise<CommitStatuses> {
  const read: unknown = await github.commitStatuses(repository, commit);
  if (!(read instanceof Map)) {
    throw new Error('the commit statuses were not read as a map');
  }
  const entries: Iterable<readonly [unknown, unknown]> = read;
  const statuses = new Map<string, CommitStatusState>();
  for (const [name, state] of entries) {
    if (typeof name !== 'string' || !isStatusState(state)) {
      throw new Error('the commit statuses hold an entry that is not a context name and a state');
    }
    statuses.set(name, state);
  }
  return statuses;
}

/** Read the declaration at the source, decide each lane, and read the statuses on `commit`. */
async function readCommit(
  github: GitHubReader,
  repository: string,
  commit: string,
  source: CommitSource,
  considered: Considered,
): Promise<CommitRead> {
  const files = commitFiles(source);
  const declaration = await readDeclaration(files);
  if (declaration.kind === 'none') {
    return { kind: 'no-declaration' };
  }
  if (declaration.kind === 'refused') {
    const statuses = await readStatuses(github, repository, commit);
    return { cause: declaration.cause, kind: 'refused', statuses };
  }
  const workflowAt = workflowsAt(files, considered.trigger);
  const lanes: LaneDecision[] = [];
  for (const lane of declaration.lanes) {
    // oxlint-disable-next-line no-await-in-loop -- one lane at a time, in declaration order
    lanes.push(decideLane(lane, await workflowAt(lane.workflow), considered.context));
  }
  return { kind: 'lanes', lanes, statuses: await readStatuses(github, repository, commit) };
}

/** A failed GitHub or git read, which skips what was being read for this poll. */
function isReadFailure(error: unknown): error is GitHubReadError | SourceError {
  return error instanceof GitHubReadError || error instanceof SourceError;
}

/**
 * Why a read failed; any error other than a failed GitHub or git read is marked unexpected. It
 * never throws, whatever was thrown, so recording a failure cannot fail the poll.
 */
function failureOf(error: unknown): ReadFailure {
  let expected = false;
  try {
    expected = isReadFailure(error);
  } catch {
    // A value whose class cannot be checked, such as a hostile proxy, is unexpected.
  }
  return expected ? { cause: messageOf(error) } : { cause: messageOf(error), unexpected: true };
}

/** The default branch head's branch and sha, read and checked before anything can fail on them. */
type HeadAt = { readonly branch: string; readonly sha: string };

/**
 * The default branch head's branch and sha, checked to be text. A head that is not an object, or
 * whose branch or sha is not text or cannot be read, throws, which fails the repository's read.
 */
function headAt(head: unknown): HeadAt {
  if (typeof head !== 'object' || head === null) {
    throw new Error('the default branch head was not read as an object');
  }
  const branch: unknown = Reflect.get(head, 'branch');
  const sha: unknown = Reflect.get(head, 'sha');
  if (typeof branch !== 'string' || typeof sha !== 'string') {
    throw new Error("the default branch head's branch or sha is not text");
  }
  return { branch, sha };
}

/**
 * The default branch head, as a `push` of that branch. Any failure to decide it, from its skip
 * instruction to its source, is its `failed` read, so the repository's pull requests are still
 * read. `at` was read before, so recording a failure reads nothing that can fail.
 */
async function readPush(
  deps: PollDeps,
  repository: string,
  at: HeadAt,
  head: BranchHead,
): Promise<CommitSnapshot> {
  const snapshot = (read: CommitRead): CommitSnapshot => ({
    commit: at.sha,
    event: { branch: at.branch, kind: 'push' },
    read,
    repository,
  });
  try {
    if (skipsWorkflows(head.message)) {
      return snapshot({ kind: 'skipped' });
    }
    return snapshot(await readPushAt(deps, repository, at));
  } catch (error) {
    return snapshot({ kind: 'failed', ...failureOf(error) });
  }
}

/** The default branch head's read, at its source. */
async function readPushAt(deps: PollDeps, repository: string, head: HeadAt) {
  const source = await deps.openPush(repository, head.sha);
  const considered: Considered = {
    context: {
      event: 'push',
      refName: head.branch,
      refType: 'branch',
      repository,
      sha: source.sha,
    },
    trigger: { branch: head.branch, changedFiles: once(source.changedFiles), kind: 'push' },
  };
  return readCommit(deps.github, repository, head.sha, source, considered);
}

/** An open pull request, at the merge commit current now; its outcome belongs on its head. */
async function readPull(
  deps: PollDeps,
  repository: string,
  number: number,
): Promise<CommitSnapshot> {
  const facts = await deps.github.pullRequest(repository, number);
  // Read and checked before the opener can fail, so recording its outcome reads nothing that can
  // fail, and the queue sorts and keys by plain, well-formed values.
  const pullRequest = pullRequestRef(facts);
  const commit: unknown = pullRequest.headSha;
  if (typeof commit !== 'string' || pullRequest.number !== number) {
    throw new TypeError(
      `the facts read for pull request ${number} lack a head sha or name another pull request`,
    );
  }
  const event: CommitSnapshot['event'] = { kind: 'pull_request', pullRequest };
  const snapshot = (read: CommitRead): CommitSnapshot => ({ commit, event, read, repository });
  let source: CommitSource;
  try {
    source = await deps.openPullRequest(repository, facts);
  } catch (error) {
    if (error instanceof NoCurrentMergeError) {
      return snapshot({ cause: error.message, kind: 'no-merge' });
    }
    throw error;
  }
  // The opener fetched the head and checked it is the head GitHub reported, so git reads its message.
  if (skipsWorkflows(await source.commitMessage(commit))) {
    return snapshot({ kind: 'skipped' });
  }
  const considered: Considered = {
    context: pullRequestEvent(facts, repository, source.sha),
    trigger: {
      baseRef: facts.baseRef,
      changedFiles: once(source.changedFiles),
      kind: 'pull_request',
    },
  };
  return snapshot(await readCommit(deps.github, repository, commit, source, considered));
}

/**
 * The numbers of the pull requests whose author the allowlist admits, compared
 * case-insensitively, each once: a listing read page by page can repeat a pull request when the
 * list shifts between pages, and reading it twice could keep a head it has since left. A number
 * that is not a positive integer, or cannot be read, throws, which fails the repository's read.
 */
function admitted(pulls: readonly OpenPullRequest[], allowlist: readonly string[]): number[] {
  const logins = new Set(allowlist.map((login) => login.toLowerCase()));
  const numbers = pulls
    .filter((pull) => pull.authorLogin !== null && logins.has(pull.authorLogin.toLowerCase()))
    .map(({ number }) => {
      if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error('a listed pull request has no positive integer number');
      }
      return number;
    });
  return [...new Set(numbers)];
}

/**
 * Read one repository. Every error is kept to the scope it was read in: a failed
 * repository-level read (the repository, its default branch, the open-pull-request listing) fails
 * the repository; a failed read of the default branch head's source fails only that head; a failed
 * read of one pull request skips only that pull request. Each value a failure is recorded under,
 * the head's sha and branch and each pull request's number, is read and checked in the
 * repository-level read, so recording a failure cannot itself fail.
 */
async function readRepositoryScopes(
  config: Pick<HugiConfig, 'allowlist'>,
  deps: PollDeps,
  repository: string,
): Promise<RepositorySnapshot> {
  let head: BranchHead;
  let at: HeadAt;
  let pulls: number[];
  try {
    head = await deps.github.defaultBranchHead(repository);
    at = headAt(head);
    pulls = admitted(await deps.github.openPullRequests(repository), config.allowlist);
  } catch (error) {
    return { kind: 'failed', repository, ...failureOf(error) };
  }
  const defaultBranch = await readPush(deps, repository, at, head);
  const pullRequests: CommitSnapshot[] = [];
  const pullRequestFailures: PullRequestReadFailure[] = [];
  for (const number of pulls) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one pull request at a time in the shared clone
      pullRequests.push(await readPull(deps, repository, number));
    } catch (error) {
      pullRequestFailures.push({ number, ...failureOf(error) });
    }
  }
  return { defaultBranch, kind: 'read', pullRequestFailures, pullRequests, repository };
}

/**
 * Read one repository, its scopes as `readRepositoryScopes` keeps them. Should anything still
 * escape them, the whole repository is its `failed` read, marked unexpected, so one repository
 * can never fail the poll.
 */
async function readRepository(
  config: Pick<HugiConfig, 'allowlist'>,
  deps: PollDeps,
  repository: string,
): Promise<RepositorySnapshot> {
  try {
    return await readRepositoryScopes(config, deps, repository);
  } catch (error) {
    return { kind: 'failed', repository, ...failureOf(error), unexpected: true };
  }
}

/**
 * Read every enrolled repository, one at a time in configuration order. Given a valid
 * configuration, it never rejects, whatever its dependencies return, throw, or reject with: a
 * read that fails, or answers a value of the wrong shape, is recorded as the `failed` read of the
 * repository, default branch head, or pull request it belongs to, and the others are still read.
 * The values `deriveQueue` reads from the snapshot, each commit's sha, its default branch or pull
 * request number, and its statuses, are checked as they are read, so deriving the queue from the
 * snapshot never throws.
 */
export async function pollRepositories(
  config: Pick<HugiConfig, 'allowlist' | 'repositories'>,
  deps: PollDeps,
): Promise<Snapshot> {
  const snapshot: RepositorySnapshot[] = [];
  for (const repository of config.repositories) {
    // oxlint-disable-next-line no-await-in-loop -- repositories are read in configuration order
    snapshot.push(await readRepository(config, deps, repository));
  }
  return snapshot;
}
