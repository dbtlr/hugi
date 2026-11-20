/** Helpers shared by the run store's tests. */
import { recordedLane } from './record';
import type { FinishedRecord, RunningRecord } from './record';

export function sampleRecord(overrides: Partial<FinishedRecord> = {}): FinishedRecord {
  return {
    commit: { head: 'a'.repeat(40) },
    endedAt: '2026-11-19T10:05:00.000Z',
    event: 'push',
    lane: recordedLane({ job: 'test', matrix: { os: 'macos-15', xcode: 16 }, workflow: 'ci.yml' }),
    reason: 'step-failed',
    repository: 'dbtlr/hugi',
    runId: '2026-11-19T100000Z-aaaaaaaaa-abc123',
    startedAt: '2026-11-19T10:00:00.000Z',
    state: 'finished',
    steps: [
      { index: 1, log: '01-build.log', name: 'Build', outcome: 'failure' },
      { index: 2, name: 'Test', outcome: 'skipped' },
    ],
    verdict: 'fail',
    version: 1,
    ...overrides,
  };
}

/** A record written when the run's directory was created, before the run ended. */
export function sampleRunningRecord(overrides: Partial<RunningRecord> = {}): RunningRecord {
  const { commit, event, lane, repository, runId, startedAt, version } = sampleRecord();
  return {
    commit,
    event,
    lane,
    repository,
    runId,
    startedAt,
    state: 'running',
    version,
    ...overrides,
  };
}

/** The error a promise rejects with; fails when it resolves. */
export async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the promise to reject');
}
