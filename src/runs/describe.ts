/** What a run's record says about its status: the failing step and the lane status it stands for. */
import type { LaneStatus } from '../github/statuses';
import type { FinishedRecord, RecordedStep, RunRecord } from './record';

/**
 * The first step that failed or timed out and set the verdict, which is the one whose log explains
 * it. A failure that `continue-on-error` let pass did not set it.
 */
export function failingStep(record: FinishedRecord): RecordedStep | undefined {
  return record.steps.find(
    (step) =>
      (step.outcome === 'failure' || step.outcome === 'timeout') && step.continuedOnError !== true,
  );
}

/**
 * The lane status a run's record stands for: its state, its cause and failing step when it
 * failed, and its run id, so the description leads to `hugi logs <id>`. A running run is pending.
 * A run with no verdict posts no status, so it has none. The status reporter is the only place
 * that turns a `LaneStatus` into a description.
 */
export function laneStatusOf(record: RunRecord): LaneStatus | undefined {
  if (record.state === 'running') {
    return { runId: record.runId, state: 'pending' };
  }
  if (record.verdict === 'none') {
    return undefined;
  }
  const step = failingStep(record);
  const failed = record.verdict === 'fail';
  return {
    runId: record.runId,
    state: failed ? 'failure' : 'success',
    ...(failed && record.detail !== undefined ? { cause: record.detail } : {}),
    ...(failed && step !== undefined ? { step: step.name } : {}),
  };
}
