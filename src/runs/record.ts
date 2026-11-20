/**
 * A run's record: `run.json` in the run's directory, beside its step logs. `hugi run` writes it as
 * `running` when the directory is created and rewrites it as `finished` when the run ends; the later
 * service will use the same writer. The run id is the run directory's name, so a record never has
 * to be looked up by anything else.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { messageOf } from '../errors';
import { laneStatusName } from '../github/status-name';
import type { LaneRef } from '../lane/step-plan';

/** The record's file name inside a run directory. */
export const RECORD_FILE = 'run.json';

/** One step as the record keeps it; `log` is the log's file name inside the run directory. */
export type RecordedStep = {
  readonly index: number;
  readonly name: string;
  readonly outcome: string;
  readonly log?: string;
  /** The step failed, but its `continue-on-error` kept it from setting the verdict. */
  readonly continuedOnError?: true;
};

type RecordBase = {
  /** The format's version, so a later reader can tell an older record from a newer one. */
  readonly version: 1;
  /** The run directory's name. */
  readonly runId: string;
  readonly lane: {
    readonly workflow: string;
    readonly job: string;
    /** The complete matrix row; empty for a job with no matrix. */
    readonly matrix: LaneRef['matrix'];
    /** The commit status the lane posts under (`laneStatusName`). */
    readonly statusName: string;
  };
  /** `owner/name`, or `local/<directory>` for a local repository. */
  readonly repository: string;
  readonly commit: {
    /** The commit a status lands on: the default branch head, or the pull request's head. */
    readonly head: string;
    /** For a pull request, the merge commit the lane ran on (ADR-0005). */
    readonly merge?: string;
  };
  readonly event: 'push' | 'pull_request';
  /** ISO 8601 UTC, as `Date.prototype.toISOString` writes it. */
  readonly startedAt: string;
};

/** Written when the run's directory is created, so a run in flight is visible before it ends. */
export type RunningRecord = RecordBase & { readonly state: 'running' };

/** Rewritten when the run ends. */
export type FinishedRecord = RecordBase & {
  readonly state: 'finished';
  /** ISO 8601 UTC, as `Date.prototype.toISOString` writes it. */
  readonly endedAt: string;
  readonly verdict: 'pass' | 'fail' | 'none';
  /** Why the run ended as it did; for a run with no verdict, the cause. */
  readonly reason: string;
  readonly detail?: string;
  readonly steps: readonly RecordedStep[];
};

export type RunRecord = RunningRecord | FinishedRecord;

/** The record could not be read or is not a Hugi run record. */
export class RunRecordError extends Error {
  override readonly name = 'RunRecordError';
}

/** The lane block of a record: its identity and the status name derived from it. */
export function recordedLane(lane: LaneRef): RunRecord['lane'] {
  return {
    job: lane.job,
    matrix: lane.matrix,
    statusName: laneStatusName(lane),
    workflow: lane.workflow,
  };
}

/** A step's log file name, from the host path the runner reports. */
export function logNameOf(logFile: string | undefined): string | undefined {
  return logFile === undefined ? undefined : basename(logFile);
}

/** The file operations `writeRunRecord` uses; the seam a test replaces to watch the order of them. */
export type RecordFiles = {
  readonly writeFile: (path: string, text: string, options: { mode: number }) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rm: (path: string, options: { force: true }) => Promise<void>;
};

const REAL_FILES: RecordFiles = { rename, rm, writeFile };

/**
 * Write the record into `runDir` atomically: a temporary file in the same directory, then a
 * rename, so a reader sees the old record or the whole new one and never half of one. Writers
 * running at the same time use different temporary names.
 */
export async function writeRunRecord(
  runDir: string,
  record: RunRecord,
  files: RecordFiles = REAL_FILES,
): Promise<void> {
  const final = join(runDir, RECORD_FILE);
  const temporary = join(runDir, `.${RECORD_FILE}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await files.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    await files.rename(temporary, final);
  } catch (error) {
    await files.rm(temporary, { force: true });
    throw error;
  }
}

const VERDICTS = new Set(['pass', 'fail', 'none']);
const EVENTS = new Set(['push', 'pull_request']);

/** What `Date.prototype.toISOString` writes: `2026-11-19T10:00:00.000Z`. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** A step log's file name, as `stepLogName` writes it: `NN-<slug>.log`, never a path. */
const STEP_LOG_NAME = /^\d{2,}-[a-z0-9]+(?:-[a-z0-9]+)*\.log$/u;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

/** Whether `value` is a full ISO 8601 UTC timestamp naming a real instant. */
export function isIsoTimestamp(value: unknown): value is string {
  return (
    isString(value) &&
    ISO_TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isStep(value: unknown): value is RecordedStep {
  if (!isObject(value)) {
    return false;
  }
  const { continuedOnError, index, log, name, outcome } = value;
  return (
    (continuedOnError === undefined || continuedOnError === true) &&
    typeof index === 'number' &&
    Number.isInteger(index) &&
    isString(name) &&
    isString(outcome) &&
    (log === undefined || (isString(log) && log === basename(log) && STEP_LOG_NAME.test(log)))
  );
}

function isLane(value: unknown): value is RecordBase['lane'] {
  return (
    isObject(value) &&
    isString(value.workflow) &&
    isString(value.job) &&
    isString(value.statusName) &&
    isObject(value.matrix)
  );
}

function isCommit(value: unknown): value is RecordBase['commit'] {
  return (
    isObject(value) &&
    isString(value.head) &&
    value.head !== '' &&
    (value.merge === undefined || isString(value.merge))
  );
}

function isBase(record: Record<string, unknown>): boolean {
  return (
    record.version === 1 &&
    isString(record.runId) &&
    isLane(record.lane) &&
    isString(record.repository) &&
    isCommit(record.commit) &&
    isString(record.event) &&
    EVENTS.has(record.event) &&
    isIsoTimestamp(record.startedAt)
  );
}

function isFinishedPart(record: Record<string, unknown>): boolean {
  return (
    isIsoTimestamp(record.endedAt) &&
    isString(record.verdict) &&
    VERDICTS.has(record.verdict) &&
    isString(record.reason) &&
    (record.detail === undefined || isString(record.detail)) &&
    Array.isArray(record.steps) &&
    record.steps.every(isStep)
  );
}

function isRecord(value: unknown): value is RunRecord {
  if (!isObject(value) || !isBase(value)) {
    return false;
  }
  return value.state === 'running' || (value.state === 'finished' && isFinishedPart(value));
}

/** Read the record in `runDir`; a missing, unreadable, or malformed one is a `RunRecordError`. */
export async function readRunRecord(runDir: string): Promise<RunRecord> {
  const path = join(runDir, RECORD_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new RunRecordError(`No readable run record at ${path}: ${messageOf(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RunRecordError(`The run record ${path} is not valid JSON: ${messageOf(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new RunRecordError(`${path} is not a Hugi run record (version 1).`);
  }
  return parsed;
}
