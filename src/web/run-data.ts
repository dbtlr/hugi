/**
 * What the run page shows of one run, read from the runs directory as `hugi logs` reads it: the
 * record (or why it is refused, or that there is none) and, for a finished run, each step's log.
 * Nothing here renders; reasons name paths relative to the runs directory, never absolute ones.
 */
import { join, sep } from 'node:path';

import type { FinishedRecord, RunningRecord } from '../runs/record';
import { readStepLog } from '../runs/step-log';
import type { StepLogProblem } from '../runs/step-log';
import { inspectRunDirectory, isRealDirectory } from '../runs/store';
import { LOG_READ_BYTES, logTextOf } from './log-text';

/** A step's log as the page shows it, or why it is not shown. */
export type StepLogView =
  | { readonly kind: 'text'; readonly text: string; readonly cut: boolean }
  | {
      readonly kind: 'refused';
      readonly problem: StepLogProblem;
      /** For an unreadable log, the error, with paths relative to the runs directory. */
      readonly detail?: string;
    };

export type RunPageData =
  | { readonly kind: 'not-found' }
  /** The record is refused; `reason` names paths relative to the runs directory. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** A run directory with no record, left by a run that did not finish. */
  | { readonly kind: 'orphan'; readonly runId: string }
  | { readonly kind: 'running'; readonly record: RunningRecord }
  | {
      readonly kind: 'finished';
      readonly record: FinishedRecord;
      /** One entry per step, in the record's order: its log, or undefined when it has none. */
      readonly logs: readonly (StepLogView | undefined)[];
    };

/** `message` with every path under `runsDir` written relative to it. */
export function relativeToRuns(message: string, runsDir: string): string {
  return message.replaceAll(`${runsDir}${sep}`, '');
}

async function stepLogView(path: string, runsDir: string): Promise<StepLogView> {
  const read = await readStepLog(path, LOG_READ_BYTES);
  if (read.kind === 'read') {
    return { kind: 'text', ...logTextOf(read.bytes, read.start) };
  }
  return read.problem === 'unreadable'
    ? { detail: relativeToRuns(read.message, runsDir), kind: 'refused', problem: read.problem }
    : { kind: 'refused', problem: read.problem };
}

/**
 * The run `runId` in `runsDir`. The caller has checked that `runId` has a run directory's form; it
 * must name a real directory, not a symbolic link, directly inside `runsDir`, or it is not found.
 */
export async function loadRunPage(runsDir: string, runId: string): Promise<RunPageData> {
  const dir = join(runsDir, runId);
  if (!(await isRealDirectory(dir))) {
    return { kind: 'not-found' };
  }
  const contents = await inspectRunDirectory(dir, runId);
  switch (contents.kind) {
    case 'missing': {
      return { kind: 'orphan', runId };
    }
    case 'unusable': {
      return { kind: 'refused', reason: relativeToRuns(contents.error.message, runsDir) };
    }
    case 'record': {
      const { record } = contents;
      if (record.state === 'running') {
        return { kind: 'running', record };
      }
      const logs = await Promise.all(
        record.steps.map(async (step) =>
          step.log === undefined ? undefined : stepLogView(join(dir, step.log), runsDir),
        ),
      );
      return { kind: 'finished', logs, record };
    }
    default: {
      const _exhaustive: never = contents;
      return _exhaustive;
    }
  }
}
