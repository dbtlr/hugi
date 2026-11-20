import { expect, test } from 'bun:test';

import { describeStatus } from '../github/statuses';
import { failingStep, laneStatusOf } from './describe';
import { sampleRecord, sampleRunningRecord } from './testing';

const RUN_ID = '2026-11-19T100000Z-aaaaaaaaa-abc123';

/** What the status reporter posts for a record: the one path from a run to a description. */
function descriptionOf(record: Parameters<typeof laneStatusOf>[0], mergeSha?: string) {
  const status = laneStatusOf(record);
  return status === undefined
    ? undefined
    : describeStatus({ ...status, ...(mergeSha === undefined ? {} : { mergeSha }) });
}

test('the failing step is the first that failed or timed out', () => {
  expect(failingStep(sampleRecord())?.name).toBe('Build');
  expect(
    failingStep(sampleRecord({ steps: [{ index: 1, name: 'A', outcome: 'timeout' }] }))?.index,
  ).toBe(1);
  expect(failingStep(sampleRecord({ steps: [{ index: 1, name: 'A', outcome: 'success' }] }))).toBe(
    undefined,
  );
});

test('a failed run stands for a failure with its step, cause and run id', () => {
  expect(laneStatusOf(sampleRecord({ detail: 'exit 3' }))).toEqual({
    cause: 'exit 3',
    runId: RUN_ID,
    state: 'failure',
    step: 'Build',
  });
});

test('the run id round-trips: description → hugi logs argument, within 140 characters', () => {
  const merge = 'c'.repeat(40);
  const text = descriptionOf(
    sampleRecord({ detail: `step 1 (Build) exited with code 3 ${'and so on '.repeat(30)}` }),
    merge,
  );
  expect(text).toBeDefined();
  expect(text!.length).toBeLessThanOrEqual(140);
  expect(text).toContain('Failed at Build: ');
  expect(text!.endsWith(` [run ${RUN_ID}] (merge cccccccccccc)`)).toBe(true);
  expect(/\[run ([^\]]+)\]/u.exec(text!)?.[1]).toBe(RUN_ID);
});

test('a passed run carries its run id and no cause or step', () => {
  expect(laneStatusOf(sampleRecord({ detail: 'x', verdict: 'pass' }))).toEqual({
    runId: RUN_ID,
    state: 'success',
  });
  expect(descriptionOf(sampleRecord({ detail: 'x', steps: [], verdict: 'pass' }))).toBe(
    `Passed [run ${RUN_ID}]`,
  );
});

test('a running run is pending, and a run with no verdict has no status', () => {
  expect(laneStatusOf(sampleRunningRecord())).toEqual({ runId: RUN_ID, state: 'pending' });
  expect(laneStatusOf(sampleRecord({ verdict: 'none' }))).toBeUndefined();
});
