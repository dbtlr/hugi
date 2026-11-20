/**
 * One run of a lane, by hand or for the service: read the lane at a commit, resolve its tools, run it in a VM, and
 * return the verdict. A pull request runs at GitHub's merge commit (ADR-0005). The host only reads
 * data from the repository; the VM executes the steps. Every collaborator is injected so the order
 * of operations is testable without a VM or GitHub.
 */
import { messageOf } from '../errors';
import { pullRequestEvent, PullRequestReadError } from '../github/pull-request';
import type { PullRequestFacts } from '../github/pull-request';
import { JobSkippedError, LaneReadError, LaneSelectionError, readLane } from '../lane/reader';
import type { EventContext, LaneRef, PushEvent, StepPlan } from '../lane/step-plan';
import { AmbiguousRefError, NotAFileError, SourceError } from '../source/host-source';
import type { GuestSource, HostSource } from '../source/host-source';
import { repositoryLabel } from '../source/repository-spec';
import type { GitHubRepositorySpec, RepositorySpec } from '../source/repository-spec';
import { resolveToolchains, ToolchainResolutionError } from '../toolchain/resolver';
import type { ActionResolution, ToolchainResolution } from '../toolchain/resolver';
import { checkoutStepIndex, GUEST_RUNNER_PATHS } from '../vm';
import type { RunReason, RunRequest, RunResult, StepResult } from '../vm';
import { RunUsageError } from './run-args';

/** A push run of a commit, named by its sha, branch, or tag. */
type PushTarget = {
  readonly event: 'push';
  readonly repository: RepositorySpec;
  /** A sha (short or full), a branch, or a tag. */
  readonly commit: string;
  readonly refType?: PushEvent['refType'];
  readonly refName?: string;
};

/** A pull_request run of a GitHub pull request, at its merge commit. */
type PullRequestTarget = {
  readonly event: 'pull_request';
  readonly repository: GitHubRepositorySpec;
  readonly pullRequest: number;
};

type LaneSelection = {
  readonly lane: Pick<LaneRef, 'job' | 'workflow'>;
  readonly matrix: LaneRef['matrix'];
  readonly needs: NonNullable<EventContext['needs']>;
  readonly image: string;
  /** Where the lane's tools come from (ADR-0006): the workflow alone, or also the repository's mise config. */
  readonly toolSource: RunRequest['toolSource'];
  /** Where step logs go; the default is a fresh directory from `deps.newLogDir`. */
  readonly logDir?: string;
};

export type PushRunRequest = PushTarget & LaneSelection;
export type PullRequestRunRequest = PullRequestTarget & LaneSelection;
export type RunLaneRequest = PushRunRequest | PullRequestRunRequest;

export type RunLaneDeps = {
  readonly openSource: (spec: RepositorySpec, commit: string) => Promise<HostSource>;
  /** GitHub's facts about a pull request of an `owner/name` repository. */
  readonly readPullRequest: (repository: string, number: number) => Promise<PullRequestFacts>;
  /** The pull request's merge commit, once its five conditions hold (ADR-0005). */
  readonly openPullRequestSource: (
    spec: GitHubRepositorySpec,
    facts: PullRequestFacts,
  ) => Promise<HostSource>;
  /** The VM runner with its tart, clock, and interrupt already bound. */
  readonly runInVm: (request: RunRequest) => Promise<RunResult>;
  readonly newLogDir: (sha: string) => Promise<string>;
  /** Called once the run's log directory exists and before the VM boots; the run is then in flight. */
  readonly runStarted?: (start: RunStart) => Promise<void>;
  /** Where non-fatal trouble, such as a snapshot left behind, is reported. */
  readonly warn: (message: string) => void;
};

/** What a run's record needs to say when its directory is created. */
export type RunStart = {
  readonly logDir: string;
  readonly lane: LaneRef;
  /** The commit the lane runs on: for a pull request, its merge commit. */
  readonly sha: string;
  readonly pullRequest?: { readonly number: number; readonly headSha: string };
};

/** Reasons a run has no VM result: the lane could not be read or resolved, which is a fail verdict. */
export type LaneReason = RunReason | 'lane-unreadable' | 'toolchain-unresolvable';

/**
 * A `uses:` step as the report shows it. The runner never executes an action: resolution maps it to
 * tools the "Install tools" step installs, or to a no-op with its reason.
 */
export type ResolvedActionStep = Pick<StepResult, 'index' | 'name'> & {
  readonly outcome: 'resolved';
  readonly action: ActionResolution;
};

export type ReportStep = StepResult | ResolvedActionStep;

export type LaneReport = {
  readonly verdict: RunResult['verdict'];
  readonly reason: LaneReason;
  readonly detail?: string;
  /** The full sha the commit resolved to once the source opened; for a pull request, its merge commit. */
  readonly sha?: string;
  /** For a pull_request run, once GitHub reported it: the number, and the head its status belongs on. */
  readonly pullRequest?: { readonly number: number; readonly headSha: string };
  readonly steps: readonly ReportStep[];
  /** The lane as read, with its complete matrix row; absent when no VM ran. */
  readonly lane?: LaneRef;
  /** The lane's tools, each action's resolution, and the notes; absent until resolution succeeds. */
  readonly toolchain?: ToolchainResolution;
  readonly logDir?: string;
  readonly timings?: RunResult['timings'];
  /** The VM teardown could not delete: an operator has to run `tart delete` on it. */
  readonly leakedVm?: string;
};

/** 0 pass, 1 fail, 3 no verdict; Loom's usage errors keep 2. */
export function exitCodeForVerdict(verdict: LaneReport['verdict']): 0 | 1 | 3 {
  if (verdict === 'pass') {
    return 0;
  }
  return verdict === 'fail' ? 1 : 3;
}

/** A name that is both a branch and a tag is the caller's to settle, so it is a usage error. */
async function refusingAmbiguity<Value>(pending: Promise<Value>): Promise<Value> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof AmbiguousRefError) {
      throw new RunUsageError(
        `"${error.refName}" is both a branch and a tag. Pass its sha with --ref-type and --ref-name.`,
      );
    }
    throw error;
  }
}

function resolvePushEvent(request: PushRunRequest, source: HostSource): EventContext {
  const named = source.refKind;
  const refName = request.refName ?? (named === undefined ? undefined : request.commit);
  if (refName === undefined) {
    throw new RunUsageError(
      `"${request.commit}" is not a branch or tag, so --ref-name is required.`,
    );
  }
  return {
    event: 'push',
    needs: request.needs,
    refName,
    refType: request.refType ?? named ?? 'branch',
    repository: repositoryLabel(request.repository),
    sha: source.sha,
  };
}

/** Clean up the guest's source on the host; a failure leaves it behind, so it is a warning. */
async function release(guest: GuestSource, warn: (message: string) => void): Promise<void> {
  try {
    await guest.release();
  } catch (error) {
    const where = guest.location.kind === 'local' ? ` at ${guest.location.path}` : '';
    warn(`could not remove the source snapshot${where}; delete it by hand: ${messageOf(error)}`);
  }
}

/** Read the lane, or explain why it cannot be read; either way the host executes nothing. */
async function readPlan(
  request: RunLaneRequest,
  source: HostSource,
  event: EventContext,
): Promise<StepPlan> {
  let text: string | undefined;
  try {
    text = await source.readFile(request.lane.workflow);
  } catch (error) {
    if (error instanceof NotAFileError) {
      throw new LaneReadError(error.message);
    }
    throw error;
  }
  if (text === undefined) {
    throw new LaneReadError(`${request.lane.workflow} does not exist at ${source.sha}.`);
  }
  try {
    return readLane(text, { ...request.lane, matrix: request.matrix }, event, GUEST_RUNNER_PATHS);
  } catch (error) {
    throw selectionAsUsage(error);
  }
}

/**
 * A selection that picks no runnable lane is the caller's to fix, not a verdict on the code: it
 * becomes a usage error. Any other error passes through unchanged.
 */
function selectionAsUsage(error: unknown): unknown {
  if (error instanceof JobSkippedError) {
    return new RunUsageError(
      `${error.message}: it is skipped for this event, as on GitHub, and Hugi gives no verdict.`,
    );
  }
  if (error instanceof LaneSelectionError) {
    return new RunUsageError(error.message);
  }
  return error;
}

const noVm = (
  reason: LaneReason,
  verdict: 'fail' | 'none',
  detail: string,
  sha?: string,
): LaneReport => ({
  detail,
  reason,
  steps: [],
  verdict,
  ...(sha === undefined ? {} : { sha }),
});

/**
 * The source's reader, keeping the first `SourceError` it throws. The toolchain resolver wraps
 * every read failure as its own error, so the kept one tells a lost read from a bad toolchain.
 */
function recordingReader(source: HostSource) {
  const record: { failure?: SourceError } = {};
  const readFile = async (path: string) => {
    try {
      return await source.readFile(path);
    } catch (error) {
      if (error instanceof SourceError) {
        record.failure ??= error;
      }
      throw error;
    }
  };
  return { readFile, record };
}

/** Resolve the plan's tools, or say why they cannot be resolved, without booting a VM. */
async function resolveTools(
  plan: StepPlan,
  source: HostSource,
): Promise<{ toolchain: ToolchainResolution } | { report: LaneReport }> {
  const reader = recordingReader(source);
  try {
    return { toolchain: await resolveToolchains(plan, reader.readFile) };
  } catch (error) {
    const lost = reader.record.failure;
    if (lost !== undefined) {
      return { report: noVm('infrastructure', 'none', lost.message, source.sha) };
    }
    if (error instanceof ToolchainResolutionError) {
      return { report: noVm('toolchain-unresolvable', 'fail', messageOf(error), source.sha) };
    }
    throw error;
  }
}

/**
 * The VM's step results, with each action step shown as what it resolved to. The checkout step
 * keeps its own result, since the runner performs it.
 */
function withResolvedActions(
  plan: StepPlan,
  steps: readonly StepResult[],
  actions: readonly ActionResolution[],
): ReportStep[] {
  const checkout = checkoutStepIndex(plan);
  const byIndex = new Map(
    actions.filter((action) => action.index !== checkout).map((action) => [action.index, action]),
  );
  return steps.map((step) => {
    const action = byIndex.get(step.index);
    return action === undefined
      ? step
      : { action, index: step.index, name: step.name, outcome: 'resolved' };
  });
}

/** The opened source and the event it stands for, or the report of why it could not open. */
type Opened =
  | { readonly source: HostSource; readonly event: EventContext }
  | { readonly report: LaneReport };

/** Open a push run's source at its commit and settle its ref values. */
async function openPush(request: PushRunRequest, deps: RunLaneDeps): Promise<Opened> {
  let source: HostSource;
  try {
    source = await refusingAmbiguity(deps.openSource(request.repository, request.commit));
  } catch (error) {
    if (error instanceof SourceError) {
      return { report: noVm('infrastructure', 'none', error.message) };
    }
    throw error;
  }
  return { event: resolvePushEvent(request, source), source };
}

/**
 * Read the pull request from GitHub and open its merge commit. A pull request GitHub cannot report
 * and one with no current merge both have no verdict, as a commit the source cannot fetch.
 */
async function openPullRequest(request: PullRequestRunRequest, deps: RunLaneDeps): Promise<Opened> {
  let facts: PullRequestFacts;
  try {
    facts = await deps.readPullRequest(request.repository.name, request.pullRequest);
  } catch (error) {
    if (error instanceof PullRequestReadError) {
      return { report: noVm('infrastructure', 'none', error.message) };
    }
    throw error;
  }
  const { headSha, number } = facts;
  let source: HostSource;
  try {
    source = await deps.openPullRequestSource(request.repository, facts);
  } catch (error) {
    if (error instanceof SourceError) {
      return {
        report: {
          ...noVm('infrastructure', 'none', error.message),
          pullRequest: { headSha, number },
        },
      };
    }
    throw error;
  }
  const event: EventContext = {
    ...pullRequestEvent(facts, request.repository.name, source.sha),
    needs: request.needs,
  };
  return { event, source };
}

/** The pull request a report stands for: its number and head, where its status belongs. */
function pullRequestOf(event: EventContext): Pick<LaneReport, 'pullRequest'> {
  if (event.event !== 'pull_request') {
    return {};
  }
  const { headSha, number } = event.pullRequest;
  return { pullRequest: { headSha, number } };
}

/** Read the lane, resolve its tools, then run it in a VM; return the verdict with the evidence. */
export async function runLane(request: RunLaneRequest, deps: RunLaneDeps): Promise<LaneReport> {
  const opened =
    request.event === 'pull_request'
      ? await openPullRequest(request, deps)
      : await openPush(request, deps);
  if ('report' in opened) {
    return opened.report;
  }
  const { event, source } = opened;
  return { ...(await runAtSource(request, deps, source, event)), ...pullRequestOf(event) };
}

/** Read the lane at the opened source, resolve its tools, and run it in a VM. */
async function runAtSource(
  request: RunLaneRequest,
  deps: RunLaneDeps,
  source: HostSource,
  event: EventContext,
): Promise<LaneReport> {
  let plan: StepPlan;
  try {
    plan = await readPlan(request, source, event);
  } catch (error) {
    if (error instanceof LaneReadError) {
      return noVm('lane-unreadable', 'fail', error.message, source.sha);
    }
    if (error instanceof SourceError) {
      return noVm('infrastructure', 'none', error.message, source.sha);
    }
    throw error;
  }
  const resolved = await resolveTools(plan, source);
  if ('report' in resolved) {
    return resolved.report;
  }
  // A fault in the lane's tools, which the run owns (ADR-0006), so no VM boots for it.
  if (request.toolSource === 'mise' && checkoutStepIndex(plan) === undefined) {
    return noVm(
      'toolchain-unresolvable',
      'fail',
      'the lane takes its tools from the mise config (tools: mise), but its job has no actions/checkout step, so there is no repository config to read.',
      source.sha,
    );
  }
  return runInGuest(request, deps, source, { event, plan, toolchain: resolved.toolchain });
}

/**
 * Prepare the guest's source, run the lane in a VM, and release the source on every exit path,
 * a throw included.
 */
async function runInGuest(
  request: RunLaneRequest,
  deps: RunLaneDeps,
  source: HostSource,
  lane: { event: EventContext; plan: StepPlan; toolchain: ToolchainResolution },
): Promise<LaneReport> {
  const { event, plan, toolchain } = lane;
  let guest: GuestSource;
  try {
    guest = await source.guestSource();
  } catch (error) {
    if (error instanceof SourceError) {
      return noVm('infrastructure', 'none', error.message, source.sha);
    }
    throw error;
  }
  let logDir: string;
  let result: RunResult;
  try {
    // Inside the try, so a log directory that cannot be made still releases the snapshot.
    logDir = request.logDir ?? (await deps.newLogDir(source.sha));
    await deps.runStarted?.({ lane: plan.lane, logDir, sha: source.sha, ...pullRequestOf(event) });
    result = await deps.runInVm({
      event,
      image: request.image,
      logDir,
      plan,
      source: guest.location,
      toolSource: request.toolSource,
      tools: toolchain.tools,
    });
  } finally {
    await release(guest, deps.warn);
  }
  return {
    lane: plan.lane,
    reason: result.reason,
    sha: source.sha,
    steps: withResolvedActions(plan, result.steps, toolchain.actions),
    timings: result.timings,
    toolchain,
    verdict: result.verdict,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
    ...(result.leakedVm === undefined ? {} : { leakedVm: result.leakedVm }),
    logDir,
  };
}
