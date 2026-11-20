/**
 * One run of a queued candidate for the coordinator: for a pull request, check at run start that
 * the candidate still stands (ADR-0005), then run its lane with `runLane`, keep the run's record as
 * `hugi run` does, and say what the coordinator should post. Every collaborator is injected, so
 * each outcome is testable without a VM, git, or GitHub.
 */
import { basename } from 'node:path';

import { RunUsageError } from '../commands/run-args';
import { runLane } from '../commands/run-lane';
import type { LaneReport, RunLaneDeps, RunLaneRequest } from '../commands/run-lane';
import { buildRunRecord, recordRunStart, storeRun } from '../commands/run-record';
import type { DeclaredLane } from '../declaration/read';
import { messageOf } from '../errors';
import { GitHubReadError } from '../github/client';
import type { PullRequestFacts } from '../github/pull-request';
import { laneStatusName, statusNameKey } from '../github/status-name';
import type { LaneStatus, StatusTarget } from '../github/statuses';
import type { LaneRef } from '../lane/step-plan';
import { pullRequestDeclarationAt } from '../queue/poll';
import type { Candidate } from '../queue/types';
import { laneStatusOf } from '../runs/describe';
import { NoCurrentMergeError, SourceError } from '../source/host-source';
import type { OpenedSource } from '../source/host-source';
import { createRunDirectory } from '../source/locations';
import { githubRepositorySpec } from '../source/repository-spec';
import type { GitHubRepositorySpec } from '../source/repository-spec';
import type { RunRequest, RunResult } from '../vm';

/** The golden image every coordinator run clones. */
export const SERVICE_IMAGE = 'hugi-golden';

/** What a candidate's run came to, and so what the coordinator posts. */
export type CandidateOutcome =
  /**
   * The candidate no longer stands: no status, and no wait; the next poll considers it again. With
   * `waits`, run start no longer selects a lane the poll selected (its lane reader refuses it, or
   * the merge no longer declares it or leaves it out), so the next poll may select it again: the
   * lane waits as after a run with no verdict.
   */
  | { readonly kind: 'dropped'; readonly reason: string; readonly waits?: true }
  /** The merge refuses the declaration: post the `hugi` status on `target`. */
  | { readonly kind: 'declaration-refused'; readonly target: StatusTarget; readonly cause: string }
  | {
      readonly kind: 'finished';
      /** The head commit, and for a pull request the merge commit the lane ran on, once resolved. */
      readonly target: StatusTarget;
      /** The lane as it ran; its status is posted under `laneStatusName(lane)`. */
      readonly lane: LaneRef;
      /** The final status to post, or undefined when the run has no verdict. */
      readonly status: LaneStatus | undefined;
      /** Why the run has no verdict, when it has none. */
      readonly cause?: string;
    };

/** A run about to boot its VM: its record exists, and its `pending` status may be posted. */
export type CandidateRunStart = {
  readonly runId: string;
  /** The id the run's VM is named by. */
  readonly vmId: string;
  readonly target: StatusTarget;
  readonly lane: LaneRef;
};

export type CandidateHooks = {
  /** Called once the run's record is written and before its VM boots. */
  readonly started: (start: CandidateRunStart) => Promise<void>;
};

export type RunCandidate = (
  candidate: Candidate,
  hooks: CandidateHooks,
) => Promise<CandidateOutcome>;

export type RunCandidateDeps = {
  /** GitHub's single-pull-request read, through the App's credential. */
  readonly readPullRequest: (repository: string, number: number) => Promise<PullRequestFacts>;
  /** The repository at a commit (`openHostSource` with the service's source options). */
  readonly openSource: RunLaneDeps['openSource'];
  /** The pull request at its merge commit, once ADR-0005's conditions hold (`openPullRequestSource`). */
  readonly openPullRequestSource: (
    spec: GitHubRepositorySpec,
    facts: PullRequestFacts,
  ) => Promise<OpenedSource>;
  /** The VM runner, with tart, the clock, and the stop signal bound, naming its VM by `vmId`. */
  readonly runInVm: (request: RunRequest, vmId: string) => Promise<RunResult>;
  readonly newVmId: () => string;
  /** Where each run's directory is created. */
  readonly runsDir: string;
  /** The configuration file retention reads its limits from. */
  readonly configPath: string;
  readonly now: () => Date;
  readonly warn: (message: string) => void;
};

const laneRefOf = ({ job, matrix, workflow }: LaneRef): LaneRef => ({ job, matrix, workflow });

/** The run's request for a lane: no upstream outputs, since lanes have no needs (ADR-0004). */
function selection(lane: DeclaredLane) {
  return {
    image: SERVICE_IMAGE,
    lane: { job: lane.job, workflow: lane.workflow },
    matrix: lane.matrix,
    needs: {},
    toolSource: lane.tools,
  } as const;
}

/**
 * The final status a report stands for: from the stored record when the run had a directory, and
 * otherwise, for a lane that could not be read or whose tools could not be resolved, a failure
 * with the report's cause and no run id, because there is no record to lead to.
 */
export function finalStatusOf(
  request: RunLaneRequest,
  report: LaneReport,
  times: { readonly startedAt: Date; readonly endedAt: Date },
): LaneStatus | undefined {
  const record = buildRunRecord(request, report, times);
  if (record !== undefined) {
    return laneStatusOf(record);
  }
  if (report.verdict !== 'fail') {
    return undefined;
  }
  return { state: 'failure', ...(report.detail === undefined ? {} : { cause: report.detail }) };
}

/** A finished run with no verdict. */
function noVerdict(target: StatusTarget, lane: LaneRef, cause: string): CandidateOutcome {
  return { cause, kind: 'finished', lane: laneRefOf(lane), status: undefined, target };
}

/** The candidate's lane at the merge, matched by status name, or why the merge drops it. */
function laneAtMerge(
  candidate: Candidate,
  lanes: readonly { readonly kind: 'runs' | 'left-out'; readonly lane: DeclaredLane }[],
): DeclaredLane | string {
  const key = statusNameKey(candidate.statusName);
  const decision = lanes.find((each) => statusNameKey(laneStatusName(each.lane)) === key);
  if (decision === undefined) {
    return `the merge commit no longer declares ${candidate.statusName}`;
  }
  if (decision.kind === 'left-out') {
    return `the merge commit's trigger or if: leaves ${candidate.statusName} out`;
  }
  return decision.lane;
}

export function createRunCandidate(deps: RunCandidateDeps): RunCandidate {
  /** Run the request through `runLane`, keep its record, and return the status it stands for. */
  const run = async (
    request: RunLaneRequest,
    hooks: CandidateHooks,
    at: { readonly target: StatusTarget; readonly lane: LaneRef },
    laneDeps: Pick<RunLaneDeps, 'openSource' | 'openPullRequestSource' | 'readPullRequest'>,
  ): Promise<CandidateOutcome> => {
    const vmId = deps.newVmId();
    const startedAt = deps.now();
    let report: LaneReport;
    try {
      report = await runLane(request, {
        ...laneDeps,
        newLogDir: (sha) => createRunDirectory(deps.runsDir, deps.now(), sha),
        runInVm: (vmRequest) => deps.runInVm(vmRequest, vmId),
        runStarted: async (start) => {
          await recordRunStart({ request, start, startedAt });
          await hooks.started({
            lane: laneRefOf(start.lane),
            runId: basename(start.logDir),
            target: at.target,
            vmId,
          });
        },
        warn: deps.warn,
      });
    } catch (error) {
      if (error instanceof RunUsageError) {
        return { kind: 'dropped', reason: error.message, waits: true };
      }
      throw error;
    }
    await storeRun({
      configPath: deps.configPath,
      report,
      request,
      runsDir: deps.runsDir,
      startedAt,
      warn: deps.warn,
    });
    const status = finalStatusOf(request, report, { endedAt: deps.now(), startedAt });
    return {
      kind: 'finished',
      lane: laneRefOf(report.lane ?? at.lane),
      status,
      target: at.target,
      ...(status === undefined ? { cause: report.detail ?? report.reason } : {}),
    };
  };

  const runPush = (candidate: Candidate, branch: string, hooks: CandidateHooks) => {
    const request: RunLaneRequest = {
      ...selection(candidate.lane),
      commit: candidate.commit,
      event: 'push',
      refName: branch,
      refType: 'branch',
      repository: githubRepositorySpec(candidate.repository),
    };
    const target = { repository: candidate.repository, sha: candidate.commit };
    return run(
      request,
      hooks,
      { lane: candidate.lane, target },
      {
        openPullRequestSource: () => Promise.reject(new Error('a push run opens no pull request')),
        openSource: deps.openSource,
        readPullRequest: () => Promise.reject(new Error('a push run reads no pull request')),
      },
    );
  };

  /**
   * Read the pull request again; run only if its head is still the candidate's commit and it has a
   * current merge, at which the declaration, the lane's trigger and its `if:` are read again. The
   * run uses that same merge and those same facts (ADR-0005).
   */
  const runPull = async (
    candidate: Candidate,
    number: number,
    hooks: CandidateHooks,
  ): Promise<CandidateOutcome> => {
    const { repository } = candidate;
    const head = { repository, sha: candidate.commit };
    let facts: PullRequestFacts;
    try {
      facts = await deps.readPullRequest(repository, number);
    } catch (error) {
      if (error instanceof GitHubReadError) {
        return noVerdict(head, candidate.lane, error.message);
      }
      throw error;
    }
    if (facts.headSha !== candidate.commit) {
      return {
        kind: 'dropped',
        reason: `pull request ${number}'s head is now ${facts.headSha}, not ${candidate.commit}`,
      };
    }
    const spec = githubRepositorySpec(repository);
    let source: OpenedSource;
    try {
      source = await deps.openPullRequestSource(spec, facts);
    } catch (error) {
      if (error instanceof NoCurrentMergeError) {
        return { kind: 'dropped', reason: error.message };
      }
      if (error instanceof SourceError) {
        return noVerdict(head, candidate.lane, error.message);
      }
      throw error;
    }
    const target = { ...head, mergeSha: source.sha };
    let declaration;
    try {
      declaration = await pullRequestDeclarationAt(repository, facts, source);
    } catch (error) {
      if (error instanceof SourceError) {
        return noVerdict(target, candidate.lane, messageOf(error));
      }
      throw error;
    }
    // A merge that no longer selects the lane waits: the next poll may select it again, as when
    // the poll read an earlier merge, and would otherwise drop it again at every poll.
    if (declaration.kind === 'none') {
      return { kind: 'dropped', reason: 'the merge commit has no lane declaration', waits: true };
    }
    if (declaration.kind === 'refused') {
      return { cause: declaration.cause, kind: 'declaration-refused', target };
    }
    const lane = laneAtMerge(candidate, declaration.lanes);
    if (typeof lane === 'string') {
      return { kind: 'dropped', reason: lane, waits: true };
    }
    const request: RunLaneRequest = {
      ...selection(lane),
      event: 'pull_request',
      pullRequest: number,
      repository: spec,
    };
    return run(
      request,
      hooks,
      { lane, target },
      {
        openPullRequestSource: async () => source,
        openSource: () => Promise.reject(new Error('a pull request run opens its merge')),
        readPullRequest: async () => facts,
      },
    );
  };

  return (candidate, hooks) =>
    candidate.event.kind === 'push'
      ? runPush(candidate, candidate.event.branch, hooks)
      : runPull(candidate, candidate.event.pullRequest.number, hooks);
}
