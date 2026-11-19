/**
 * One poll of GitHub's state (ADR-0004 "Events", ADR-0005): for each enrolled repository, read
 * its default branch head and the open pull requests the allowlist admits, and decide which
 * declared lanes each commit's event selects. The result is a snapshot that `deriveQueue` turns
 * into the queue; nothing is stored between polls.
 */
import type { HugiConfig } from '../config/schema';
import { readDeclaration } from '../declaration/read';
import type { CommitFiles } from '../declaration/read';
import { GitHubReadError } from '../github/client';
import type { BranchHead, GitHubReader, OpenPullRequest } from '../github/client';
import type { PullRequestFacts } from '../github/pull-request';
import { loadWorkflow } from '../lane/parse';
import { JobSkippedError, LaneReadError, readLane } from '../lane/reader';
import type { EventContext, LaneRef, PullRequestRef } from '../lane/step-plan';
import { NoCurrentMergeError, NotAFileError, SourceError } from '../source/host-source';
import type { HostSource } from '../source/host-source';
import { skipsWorkflows, TriggerError, workflowStarts } from '../trigger';
import type { TriggerEvent } from '../trigger';
import { GUEST_RUNNER_PATHS } from '../vm';
import type {
  CommitRead,
  CommitSnapshot,
  LaneDecision,
  RepositorySnapshot,
  Snapshot,
} from './types';

/** The parts of a repository at one commit a poll reads: `HostSource` is one. */
export type CommitSource = Pick<HostSource, 'sha' | 'readFile' | 'changedFiles'>;

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
 * The source's files as the declaration reader takes them. A path that names a directory reads
 * as absent: a workflow that is a directory refuses the declaration as missing.
 */
function commitFiles(source: CommitSource): CommitFiles {
  return async (path) => {
    try {
      return (await source.readFile(path)) ?? null;
    } catch (error) {
      if (error instanceof NotAFileError) {
        return null;
      }
      throw error;
    }
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

/** The workflow's parsed `on:`, or `undefined` when the workflow cannot be read here. */
function triggerOf(text: string): { readonly on: unknown } | undefined {
  try {
    return { on: loadWorkflow(text).on };
  } catch {
    return undefined;
  }
}

/**
 * Whether the lane runs for the event: its workflow's `on:` must start it, then its job's `if:`
 * must hold. A lane the reader cannot otherwise read runs, so its run yields the fail verdict.
 */
async function decideLane(
  lane: LaneRef,
  files: CommitFiles,
  considered: Considered,
): Promise<LaneDecision> {
  const text = await files(lane.workflow);
  const trigger = text === null ? undefined : triggerOf(text);
  if (text === null || trigger === undefined) {
    return { kind: 'runs', lane };
  }
  try {
    if (!(await workflowStarts(trigger.on, considered.trigger))) {
      return { kind: 'left-out', lane };
    }
  } catch (error) {
    if (error instanceof TriggerError) {
      return { cause: error.message, kind: 'refused-trigger', lane };
    }
    throw error;
  }
  try {
    readLane(text, lane, considered.context, GUEST_RUNNER_PATHS);
  } catch (error) {
    if (error instanceof JobSkippedError) {
      return { kind: 'left-out', lane };
    }
    if (!(error instanceof LaneReadError)) {
      throw error;
    }
  }
  return { kind: 'runs', lane };
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
    const statuses = await github.commitStatuses(repository, commit);
    return { cause: declaration.cause, kind: 'refused', statuses };
  }
  const lanes: LaneDecision[] = [];
  for (const lane of declaration.lanes) {
    // oxlint-disable-next-line no-await-in-loop -- one lane at a time, in declaration order
    lanes.push(await decideLane(lane, files, considered));
  }
  return { kind: 'lanes', lanes, statuses: await github.commitStatuses(repository, commit) };
}

/** The default branch head, as a `push` of that branch. */
async function readPush(
  deps: PollDeps,
  repository: string,
  head: BranchHead,
): Promise<CommitSnapshot> {
  const snapshot = (read: CommitRead): CommitSnapshot => ({
    commit: head.sha,
    event: { branch: head.branch, kind: 'push' },
    read,
    repository,
  });
  if (skipsWorkflows(head.message)) {
    return snapshot({ kind: 'skipped' });
  }
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
  return snapshot(await readCommit(deps.github, repository, head.sha, source, considered));
}

/** An open pull request, at the merge commit current now; its outcome belongs on its head. */
async function readPull(
  deps: PollDeps,
  repository: string,
  number: number,
): Promise<CommitSnapshot> {
  const facts = await deps.github.pullRequest(repository, number);
  const pullRequest: PullRequestRef = {
    baseRef: facts.baseRef,
    headRef: facts.headRef,
    headSha: facts.headSha,
    number,
  };
  const snapshot = (read: CommitRead): CommitSnapshot => ({
    commit: facts.headSha,
    event: { kind: 'pull_request', pullRequest },
    read,
    repository,
  });
  if (skipsWorkflows(await deps.github.commitMessage(repository, facts.headSha))) {
    return snapshot({ kind: 'skipped' });
  }
  let source: CommitSource;
  try {
    source = await deps.openPullRequest(repository, facts);
  } catch (error) {
    if (error instanceof NoCurrentMergeError) {
      return snapshot({ cause: error.message, kind: 'no-merge' });
    }
    throw error;
  }
  const considered: Considered = {
    context: { event: 'pull_request', pullRequest, repository, sha: source.sha },
    trigger: {
      baseRef: facts.baseRef,
      changedFiles: once(source.changedFiles),
      kind: 'pull_request',
    },
  };
  return snapshot(await readCommit(deps.github, repository, facts.headSha, source, considered));
}

/** The pull requests whose author the allowlist admits, compared case-insensitively. */
function admitted(
  pulls: readonly OpenPullRequest[],
  allowlist: readonly string[],
): OpenPullRequest[] {
  const logins = new Set(allowlist.map((login) => login.toLowerCase()));
  return pulls.filter(
    (pull) => pull.authorLogin !== null && logins.has(pull.authorLogin.toLowerCase()),
  );
}

async function readRepository(
  config: Pick<HugiConfig, 'allowlist'>,
  deps: PollDeps,
  repository: string,
): Promise<RepositorySnapshot> {
  try {
    const defaultBranch = await readPush(
      deps,
      repository,
      await deps.github.defaultBranchHead(repository),
    );
    const pulls = admitted(await deps.github.openPullRequests(repository), config.allowlist);
    const pullRequests: CommitSnapshot[] = [];
    for (const pull of pulls) {
      // oxlint-disable-next-line no-await-in-loop -- one pull request at a time in the shared clone
      pullRequests.push(await readPull(deps, repository, pull.number));
    }
    return { defaultBranch, kind: 'read', pullRequests, repository };
  } catch (error) {
    if (error instanceof GitHubReadError || error instanceof SourceError) {
      return { cause: error.message, kind: 'failed', repository };
    }
    throw error;
  }
}

/**
 * Read every enrolled repository, one at a time in configuration order. A repository whose GitHub
 * or git reads fail is recorded as failed for this poll; the others are still read.
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
