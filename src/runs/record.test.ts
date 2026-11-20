import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AtomicWriteFiles } from '../atomic-write';
import {
  isIsoTimestamp,
  logNameOf,
  readRunRecord,
  RECORD_FILE,
  RunRecordError,
  writeRunRecord,
} from './record';
import { rejectionOf, sampleRecord, sampleRunningRecord } from './testing';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hugi-record-'));
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

/** The message reading `value` as the record in `dir` is refused with. */
async function refusalOf(value: unknown): Promise<string> {
  await writeFile(join(dir, RECORD_FILE), JSON.stringify(value));
  return (await rejectionOf(readRunRecord(dir))).message;
}

describe('the run record', () => {
  test('reads back what was written, running or finished', async () => {
    const finished = sampleRecord({ commit: { head: 'b'.repeat(40), merge: 'c'.repeat(40) } });
    await writeRunRecord(dir, finished);
    expect(await readRunRecord(dir)).toEqual(finished);
    const running = sampleRunningRecord();
    await writeRunRecord(dir, running);
    expect(await readRunRecord(dir)).toEqual(running);
  });

  test('keeps a step that continue-on-error let pass, and refuses any other value for the mark', async () => {
    const steps = [
      {
        continuedOnError: true as const,
        index: 1,
        log: '01-lint.log',
        name: 'Lint',
        outcome: 'failure',
      },
    ];
    await writeRunRecord(dir, sampleRecord({ steps }));
    expect(await readRunRecord(dir)).toEqual(sampleRecord({ steps }));
    expect(
      await refusalOf({ ...sampleRecord(), steps: [{ ...steps[0], continuedOnError: 'yes' }] }),
    ).toContain('not a Hugi run record');
  });

  test('names the lane by its status name and keeps the complete matrix row', () => {
    expect(sampleRecord().lane).toEqual({
      job: 'test',
      matrix: { os: 'macos-15', xcode: 16 },
      statusName: 'hugi / test (macos-15, 16)',
      workflow: 'ci.yml',
    });
  });

  test('is written atomically: no temporary file is left, and a failed write leaves nothing stray', async () => {
    await writeRunRecord(dir, sampleRunningRecord());
    await writeRunRecord(dir, sampleRecord({ verdict: 'pass' }));
    expect(await readdir(dir)).toEqual([RECORD_FILE]);
    const record = await readRunRecord(dir);
    expect(record.state === 'finished' && record.verdict).toBe('pass');
    // A non-empty directory where the record belongs makes the rename fail after the write.
    const blocked = await mkdtemp(join(dir, 'blocked-'));
    await mkdir(join(blocked, RECORD_FILE));
    await writeFile(join(blocked, RECORD_FILE, 'x'), '');
    await rejectionOf(writeRunRecord(blocked, sampleRecord()));
    expect(await readdir(blocked)).toEqual([RECORD_FILE]);
  });

  test('never writes run.json itself: the text goes to a temporary file that is renamed over it', async () => {
    const calls: string[] = [];
    const final = join(dir, RECORD_FILE);
    const files: AtomicWriteFiles = {
      rename: async (from, to) => {
        calls.push(
          `rename ${from === final ? 'run.json' : 'temporary'} -> ${to === final ? 'run.json' : to}`,
        );
      },
      rm: async () => {
        calls.push('rm');
      },
      writeFile: async (path) => {
        calls.push(`write ${path === final ? 'run.json' : 'temporary'}`);
      },
    };
    await writeRunRecord(dir, sampleRecord(), files);
    expect(calls).toEqual(['write temporary', 'rename temporary -> run.json']);
  });

  test('a reader never sees a partial record while a write is in progress', async () => {
    await writeRunRecord(dir, sampleRunningRecord());
    const seen: string[] = [];
    const files: AtomicWriteFiles = {
      rename: async (from, to) => {
        const { rename } = await import('node:fs/promises');
        await rename(from, to);
      },
      rm: async () => {},
      writeFile: async (path, text, options) => {
        // Half the text is on disk when the concurrent reader looks.
        await writeFile(path, text.slice(0, text.length / 2), options);
        seen.push(await readFile(join(dir, RECORD_FILE), 'utf8'));
        await writeFile(path, text, options);
      },
    };
    await writeRunRecord(dir, sampleRecord(), files);
    expect(JSON.parse(seen[0] ?? '').state).toBe('running');
    expect((await readRunRecord(dir)).state).toBe('finished');
  });

  test('reports a missing, malformed, or foreign record instead of crashing', async () => {
    expect(await rejectionOf(readRunRecord(dir))).toBeInstanceOf(RunRecordError);
    await writeFile(join(dir, RECORD_FILE), '{nope');
    expect((await rejectionOf(readRunRecord(dir))).message).toContain('not valid JSON');
    expect(await refusalOf({ version: 2 })).toContain('not a Hugi run record');
    expect(await refusalOf(null)).toContain('not a Hugi run record');
  });

  test('keeps only the log file name of a step', () => {
    expect(logNameOf('/state/hugi/runs/x/01-build.log')).toBe('01-build.log');
    expect(logNameOf(undefined)).toBeUndefined();
  });
});

describe('what the validator refuses', () => {
  test.each([
    '0',
    '2000',
    '1 Jan 2000',
    '2026-11-19',
    '2026-11-19T10:00:00Z',
    '2026-11-19T10:00:00.000+01:00',
    '2026-02-30T00:00:00.000Z',
    '',
  ])('a start or end time of %p', async (time) => {
    expect(await refusalOf({ ...sampleRecord(), endedAt: time })).toContain(
      'not a Hugi run record',
    );
    expect(await refusalOf({ ...sampleRecord(), startedAt: time })).toContain(
      'not a Hugi run record',
    );
  });

  test('accepts what toISOString writes', () => {
    expect(isIsoTimestamp(new Date().toISOString())).toBe(true);
    expect(isIsoTimestamp('2026-11-19T10:00:00.000Z')).toBe(true);
  });

  const good = sampleRecord();
  test.each([
    ['a commit with no head', { ...good, commit: {} }],
    ['a commit head that is not a string', { ...good, commit: { head: 5 } }],
    ['no commit', { ...good, commit: undefined }],
    ['a lane that is not an object', { ...good, lane: 'x' }],
    ['a lane matrix that is null', { ...good, lane: { ...good.lane, matrix: null } }],
    ['an unknown state', { ...good, state: 'paused' }],
    ['an unknown event', { ...good, event: 'schedule' }],
    ['a repository that is not a string', { ...good, repository: 3 }],
    ['a step that is null', { ...good, steps: [null] }],
    [
      'a step index that is fractional',
      { ...good, steps: [{ index: 1.5, name: 'A', outcome: 'success' }] },
    ],
  ])('%s', async (_name, bad) => {
    expect(await refusalOf(bad)).toContain('not a Hugi run record');
  });

  test.each([
    '../../etc/passwd',
    '/etc/passwd',
    'sub/01-build.log',
    '01-build.txt',
    'build.log',
    '01-Build.log',
    '01-.log',
    '..',
    '',
  ])('a step log of %p, which is not a log name inside the run directory', async (log) => {
    const record = sampleRecord({ steps: [{ index: 1, log, name: 'Build', outcome: 'failure' }] });
    expect(await refusalOf(record)).toContain('not a Hugi run record');
  });

  test('a running record needs no end, verdict, or steps', async () => {
    await writeRunRecord(dir, sampleRunningRecord());
    expect((await readRunRecord(dir)).state).toBe('running');
    expect(await refusalOf({ ...sampleRunningRecord(), state: 'finished' })).toContain(
      'not a Hugi run record',
    );
  });
});
