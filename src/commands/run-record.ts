/**
 * Keeping a `hugi run` in the run store: a `running` record written when the run's directory is
 * created, the `finished` record written when the run ends, then retention. None of them can
 * change the run's verdict, so a failure of any is a warning.
 */
import { access } from 'node:fs/promises';
import { basename } from 'node:path';

import { loadConfig } from '../config/load';
import { DEFAULTS } from '../config/schema';
import type { HugiConfig } from '../config/schema';
import { messageOf } from '../errors';
import { logNameOf, recordedLane, writeRunRecord } from '../runs/record';
import type { FinishedRecord, RunRecord, RunningRecord } from '../runs/record';
import { applyRetention } from '../runs/retention';
import { repositoryLabel } from '../source/repository-spec';
import type { LaneReport, RunLaneRequest, RunStart } from './run-lane';

type Identity = Pick<
  RunRecord,
  'commit' | 'event' | 'lane' | 'repository' | 'runId' | 'startedAt' | 'version'
>;

/** What both records say about a run: who it is, which commit, and when it started. */
function identityOf(
  request: RunLaneRequest,
  where: Pick<RunStart, 'lane' | 'pullRequest' | 'sha'>,
  logDir: string,
  startedAt: Date,
): Identity {
  const merge = where.pullRequest === undefined ? undefined : where.sha;
  return {
    commit: {
      head: where.pullRequest?.headSha ?? where.sha,
      ...(merge ? { merge } : {}),
    },
    event: request.event,
    lane: recordedLane(where.lane),
    repository: repositoryLabel(request.repository),
    runId: basename(logDir),
    startedAt: startedAt.toISOString(),
    version: 1,
  };
}

/** The record written when the run's directory is created. */
export function buildRunningRecord(
  request: RunLaneRequest,
  start: RunStart,
  startedAt: Date,
): RunningRecord {
  return {
    ...identityOf(request, start, start.logDir, startedAt),
    state: 'running',
  };
}

/** The record for a finished run, or undefined when it never got a directory (no VM ran). */
export function buildRunRecord(
  request: RunLaneRequest,
  report: LaneReport,
  times: { readonly startedAt: Date; readonly endedAt: Date },
): FinishedRecord | undefined {
  if (report.logDir === undefined || report.lane === undefined || report.sha === undefined) {
    return undefined;
  }
  const where = {
    lane: report.lane,
    sha: report.sha,
    ...(report.pullRequest === undefined ? {} : { pullRequest: report.pullRequest }),
  };
  return {
    ...identityOf(request, where, report.logDir, times.startedAt),
    endedAt: times.endedAt.toISOString(),
    reason: report.reason,
    state: 'finished',
    steps: report.steps.map((step) => {
      const log = step.outcome === 'resolved' ? undefined : logNameOf(step.logFile);
      return {
        index: step.index,
        name: step.name,
        outcome: step.outcome,
        ...(log ? { log } : {}),
        ...('continuedOnError' in step && step.continuedOnError ? { continuedOnError: true } : {}),
      };
    }),
    verdict: report.verdict,
    ...(report.detail === undefined ? {} : { detail: report.detail }),
  };
}

/**
 * Write the `running` record into a run's new directory. A run whose record cannot be written does
 * not start: without it, retention would take the run's directory for an abandoned one and could
 * delete it while the VM runs.
 */
export async function recordRunStart(options: {
  readonly request: RunLaneRequest;
  readonly start: RunStart;
  readonly startedAt: Date;
}): Promise<void> {
  const { request, start, startedAt } = options;
  try {
    await writeRunRecord(start.logDir, buildRunningRecord(request, start, startedAt));
  } catch (error) {
    throw new Error(
      `Cannot write the run record in ${start.logDir}: ${messageOf(error)}. The run does not start, because retention could not tell it is in flight.`,
      { cause: error },
    );
  }
}

/** Whether `path` is absent: only a missing file is; any other failure to look is not absence. */
async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  }
}

const NO_CONFIG_OPTION = '';

/**
 * The retention limits from the configuration file: the defaults when there is no file, and
 * undefined, with a warning, when a file exists and is refused, because limits Hugi could not read
 * are not limits it may delete runs by.
 */
export async function loadRetentionLimits(
  configPath: string,
  warn: (message: string) => void,
): Promise<HugiConfig['runs'] | undefined> {
  if (await missing(configPath)) {
    return { maxAgeDays: DEFAULTS.maxAgeDays, maxSizeGb: DEFAULTS.maxSizeGb };
  }
  try {
    return (await loadConfig(configPath, undefined, NO_CONFIG_OPTION)).runs;
  } catch (error) {
    warn(`${messageOf(error)} Skipping run retention for this run.`);
    return undefined;
  }
}

/** Rewrite the run's record as finished, then apply retention to the runs directory. */
export async function storeRun(options: {
  readonly request: RunLaneRequest;
  readonly report: LaneReport;
  readonly startedAt: Date;
  readonly runsDir: string;
  readonly configPath: string;
  readonly warn: (message: string) => void;
}): Promise<void> {
  const { report, runsDir, warn } = options;
  const record = buildRunRecord(options.request, report, {
    endedAt: new Date(),
    startedAt: options.startedAt,
  });
  if (record === undefined || report.logDir === undefined) {
    return;
  }
  try {
    await writeRunRecord(report.logDir, record);
  } catch (error) {
    warn(`could not write the run record in ${report.logDir}: ${messageOf(error)}`);
    return;
  }
  try {
    const limits = await loadRetentionLimits(options.configPath, warn);
    if (limits !== undefined) {
      await applyRetention(runsDir, limits, {
        keep: new Set([record.runId]),
        now: new Date(),
        warn,
      });
    }
  } catch (error) {
    warn(`could not apply run retention in ${runsDir}: ${messageOf(error)}`);
  }
}
