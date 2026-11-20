import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { createRunDirectory } from '../source/locations';
import { writeRunRecord } from './record';
import { applyRetention } from './retention';
import { findRun, RUN_DIRECTORY_NAME, RunLookupError } from './store';
import { rejectionOf, sampleRecord, sampleRunningRecord } from './testing';

/** Whether anything is at `path`, a dangling symlink excluded. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const NOW = new Date('2026-11-19T12:00:00Z');
const DAY = 86_400_000;
const GB = 1024 ** 3;
const LIMITS = { maxAgeDays: 30, maxSizeGb: 5 };
const keeping = (...ids: string[]) => ({ keep: new Set(ids), now: NOW });

let root: string;
let runsDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hugi-retention-'));
  runsDir = join(root, 'runs');
  await mkdir(runsDir);
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

/** A finished run directory that ended `ageDays` before NOW, holding `logBytes` of log. */
async function addRun(suffix: string, ageDays: number, logBytes = 10): Promise<string> {
  return addRunEndedAt(suffix, new Date(NOW.getTime() - ageDays * DAY), logBytes);
}

async function addRunEndedAt(suffix: string, endedAt: Date, logBytes = 10): Promise<string> {
  const id = `2026-10-01T000000Z-aaaaaaaaa-${suffix}`;
  const dir = join(runsDir, id);
  await mkdir(dir);
  await writeRunRecord(dir, sampleRecord({ endedAt: endedAt.toISOString(), runId: id }));
  await writeFile(join(dir, '01-build.log'), 'x'.repeat(logBytes));
  return id;
}

/** A directory that began `ageDays` before NOW and has not ended. */
async function addRunning(suffix: string, ageDays: number, logBytes = 10): Promise<string> {
  const id = `2026-10-01T000000Z-aaaaaaaaa-${suffix}`;
  const dir = join(runsDir, id);
  await mkdir(dir);
  const startedAt = new Date(NOW.getTime() - ageDays * DAY).toISOString();
  await writeRunRecord(dir, sampleRunningRecord({ runId: id, startedAt }));
  await writeFile(join(dir, '01-build.log'), 'x'.repeat(logBytes));
  return id;
}

/** A run-named directory with no record, whose modification time is `ageDays` before NOW. */
async function addOrphan(suffix: string, ageDays: number, logBytes = 10): Promise<string> {
  const id = `2026-10-01T000000Z-aaaaaaaaa-${suffix}`;
  const dir = join(runsDir, id);
  await mkdir(dir);
  await writeFile(join(dir, '01-build.log'), 'x'.repeat(logBytes));
  const when = new Date(NOW.getTime() - ageDays * DAY);
  await utimes(dir, when, when);
  return id;
}

/** The bytes retention counts for a run added by `addRun`: its record and its log. */
async function sizeOfRun(id: string): Promise<number> {
  const dir = join(runsDir, id);
  return (await stat(join(dir, 'run.json'))).size + (await stat(join(dir, '01-build.log'))).size;
}

describe('retention by age', () => {
  test('deletes runs older than the maximum age and keeps the rest', async () => {
    const old = await addRun('aaaaaa', 31);
    const fresh = await addRun('bbbbbb', 29);
    const result = await applyRetention(runsDir, LIMITS, { now: NOW });
    expect(result.deleted).toEqual([old]);
    expect(await exists(join(runsDir, old))).toBe(false);
    expect(await exists(join(runsDir, fresh))).toBe(true);
  });

  test('a run that ended exactly at the age limit stays; one millisecond older goes', async () => {
    const exact = await addRunEndedAt('aaaaaa', new Date(NOW.getTime() - 30 * DAY));
    const older = await addRunEndedAt('bbbbbb', new Date(NOW.getTime() - 30 * DAY - 1));
    expect((await applyRetention(runsDir, LIMITS, { now: NOW })).deleted).toEqual([older]);
    expect(await exists(join(runsDir, exact))).toBe(true);
  });

  test('never deletes a run it was told to keep, however old', async () => {
    const current = await addRun('aaaaaa', 90);
    const result = await applyRetention(runsDir, LIMITS, keeping(current));
    expect(result.deleted).toEqual([]);
    expect(await exists(join(runsDir, current))).toBe(true);
  });
});

describe('retention by size', () => {
  const small = { maxAgeDays: 30, maxSizeGb: 4200 / GB };

  test('deletes the oldest runs until the store fits', async () => {
    const oldest = await addRun('aaaaaa', 20, 1000);
    const middle = await addRun('bbbbbb', 10, 1000);
    const newest = await addRun('cccccc', 1, 1000);
    const result = await applyRetention(runsDir, small, { now: NOW });
    expect(result.deleted).toEqual([oldest]);
    expect(await exists(join(runsDir, middle))).toBe(true);
    expect(await exists(join(runsDir, newest))).toBe(true);
  });

  test('"oldest" is by end time, not by name', async () => {
    // Names sort the other way round, so a sort by name would delete the newest first.
    const oldest = await addRun('zzzzzz', 20, 1000);
    const middle = await addRun('mmmmmm', 10, 1000);
    const newest = await addRun('aaaaaa', 1, 1000);
    const result = await applyRetention(
      runsDir,
      { maxAgeDays: 30, maxSizeGb: 2100 / GB },
      { now: NOW },
    );
    expect(result.deleted).toEqual([oldest, middle]);
    expect(await exists(join(runsDir, newest))).toBe(true);
  });

  test('keeps the current run even when it alone passes the limit', async () => {
    const older = await addRun('aaaaaa', 20, 1000);
    const current = await addRun('bbbbbb', 30, 5000);
    const result = await applyRetention(runsDir, small, keeping(current));
    expect(result.deleted).toEqual([older]);
    expect(await exists(join(runsDir, current))).toBe(true);
  });

  test('deletes nothing while the store fits', async () => {
    await addRun('aaaaaa', 20, 1000);
    expect((await applyRetention(runsDir, LIMITS, { now: NOW })).deleted).toEqual([]);
  });

  test('a store exactly at the size limit fits; one byte over does not', async () => {
    const oldest = await addRun('aaaaaa', 20, 1000);
    const newest = await addRun('bbbbbb', 1, 1000);
    const total = (await sizeOfRun(oldest)) + (await sizeOfRun(newest));
    expect(
      await applyRetention(runsDir, { maxAgeDays: 30, maxSizeGb: total / GB }, { now: NOW }),
    ).toEqual({ deleted: [] });
    const over = await applyRetention(
      runsDir,
      { maxAgeDays: 30, maxSizeGb: (total - 1) / GB },
      { now: NOW },
    );
    expect(over.deleted).toEqual([oldest]);
  });

  test('runs already deleted by age no longer count toward the size', async () => {
    const expired = await addRun('aaaaaa', 40, 5000);
    const fresh = await addRun('bbbbbb', 1, 1000);
    const limits = { maxAgeDays: 30, maxSizeGb: (await sizeOfRun(fresh)) / GB };
    const result = await applyRetention(runsDir, limits, { now: NOW });
    expect(result.deleted).toEqual([expired]);
    expect(await exists(join(runsDir, fresh))).toBe(true);
  });

  test('a symlink inside a run counts as the link, not as the file it points to', async () => {
    const id = await addRun('aaaaaa', 20, 10);
    const big = join(root, 'big');
    await writeFile(big, '');
    await truncate(big, 50_000);
    await symlink(big, join(runsDir, id, 'link'));
    const limits = { maxAgeDays: 30, maxSizeGb: 10_000 / GB };
    expect((await applyRetention(runsDir, limits, { now: NOW })).deleted).toEqual([]);
  });

  test('does not follow a symlinked directory named like a run, nor count what it points to', async () => {
    const real = await addRun('aaaaaa', 20, 1000);
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'big'), '');
    await truncate(join(outside, 'big'), 50_000);
    await symlink(outside, join(runsDir, '2026-10-02T000000Z-aaaaaaaaa-linkdd'));
    const limits = { maxAgeDays: 30, maxSizeGb: (await sizeOfRun(real)) / GB };
    expect((await applyRetention(runsDir, limits, { now: NOW })).deleted).toEqual([]);
    expect(await exists(join(outside, 'big'))).toBe(true);
  });
});

describe('a run in flight', () => {
  test('is never deleted to make room', async () => {
    const running = await addRunning('aaaaaa', 20, 5000);
    const finished = await addRun('bbbbbb', 1, 1000);
    const result = await applyRetention(
      runsDir,
      { maxAgeDays: 30, maxSizeGb: 2000 / GB },
      { now: NOW },
    );
    expect(result.deleted).toEqual([finished]);
    expect(await exists(join(runsDir, running))).toBe(true);
  });

  test('counts toward the size total', async () => {
    const running = await addRunning('aaaaaa', 1, 5000);
    const finished = await addRun('bbbbbb', 20, 100);
    const limits = { maxAgeDays: 30, maxSizeGb: (await sizeOfRun(finished)) / GB };
    expect((await applyRetention(runsDir, limits, { now: NOW })).deleted).toEqual([finished]);
    expect(await exists(join(runsDir, running))).toBe(true);
  });

  test('is deleted once stale: started more than the age limit ago', async () => {
    const stale = await addRunning('aaaaaa', 31);
    const live = await addRunning('bbbbbb', 29);
    expect((await applyRetention(runsDir, LIMITS, { now: NOW })).deleted).toEqual([stale]);
    expect(await exists(join(runsDir, live))).toBe(true);
  });

  test('is kept when told to keep it, however stale', async () => {
    const stale = await addRunning('aaaaaa', 90);
    expect((await applyRetention(runsDir, LIMITS, keeping(stale))).deleted).toEqual([]);
  });
});

describe('an orphan: a run-named directory with no usable record', () => {
  test('is deleted once its directory time is older than the age limit, and not before', async () => {
    const old = await addOrphan('aaaaaa', 31);
    const young = await addOrphan('bbbbbb', 29);
    expect((await applyRetention(runsDir, LIMITS, { now: NOW })).deleted).toEqual([old]);
    expect(await exists(join(runsDir, young))).toBe(true);
  });

  test('an unreadable record makes an orphan too', async () => {
    const id = await addOrphan('aaaaaa', 31);
    await writeFile(join(runsDir, id, 'run.json'), 'garbage');
    const when = new Date(NOW.getTime() - 31 * DAY);
    await utimes(join(runsDir, id), when, when);
    expect((await applyRetention(runsDir, LIMITS, { now: NOW })).deleted).toEqual([id]);
  });

  test('a record whose times are not ISO timestamps is unusable, so an orphan', async () => {
    const id = await addOrphan('aaaaaa', 31);
    await writeFile(
      join(runsDir, id, 'run.json'),
      JSON.stringify({ ...sampleRecord({ runId: id }), endedAt: '0' }),
    );
    const when = new Date(NOW.getTime() - 31 * DAY);
    await utimes(join(runsDir, id), when, when);
    expect((await applyRetention(runsDir, LIMITS, { now: NOW })).deleted).toEqual([id]);
    const young = await addOrphan('bbbbbb', 1);
    await writeFile(
      join(runsDir, young, 'run.json'),
      JSON.stringify({ ...sampleRecord({ runId: young }), endedAt: 'NaN' }),
    );
    expect((await applyRetention(runsDir, LIMITS, { now: NOW })).deleted).toEqual([]);
  });

  test('counts toward the size total and may be deleted to make room, oldest first', async () => {
    const orphan = await addOrphan('aaaaaa', 20, 5000);
    const finished = await addRun('bbbbbb', 1, 100);
    const limits = { maxAgeDays: 30, maxSizeGb: (await sizeOfRun(finished)) / GB };
    expect((await applyRetention(runsDir, limits, { now: NOW })).deleted).toEqual([orphan]);
    expect(await exists(join(runsDir, finished))).toBe(true);
  });

  test('is not deleted to make room while its directory is younger than an hour, as a run that has not written its record yet', async () => {
    const starting = await addOrphan('cccccc', 0, 5000);
    const when = new Date(NOW.getTime() - 5 * 60 * 1000);
    await utimes(join(runsDir, starting), when, when);
    const finished = await addRun('bbbbbb', 1, 100);
    const limits = { maxAgeDays: 30, maxSizeGb: (await sizeOfRun(finished)) / GB };
    expect((await applyRetention(runsDir, limits, { now: NOW })).deleted).toEqual([finished]);
    expect(await exists(join(runsDir, starting))).toBe(true);
  });

  test('is kept when told to keep it', async () => {
    const orphan = await addOrphan('aaaaaa', 90);
    expect((await applyRetention(runsDir, LIMITS, keeping(orphan))).deleted).toEqual([]);
  });
});

describe('what retention never deletes', () => {
  test('a directory that is not named like a run, however old its record', async () => {
    const stranger = join(runsDir, 'my-photos');
    await mkdir(stranger);
    await writeRunRecord(
      stranger,
      sampleRecord({ endedAt: '2020-01-01T00:00:00.000Z', runId: 'my-photos' }),
    );
    await writeFile(join(stranger, 'big'), 'x'.repeat(5000));
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(stranger, old, old);
    await writeFile(join(runsDir, 'loose-file'), 'x');
    const fresh = await addRun('aaaaaa', 1, 100);
    // The stranger's bytes are not the store's: only the fresh run's count toward the size.
    const limits = { maxAgeDays: 1, maxSizeGb: (await sizeOfRun(fresh)) / GB };
    expect((await applyRetention(runsDir, limits, { now: NOW })).deleted).toEqual([]);
    expect(await Promise.all([stranger, join(runsDir, 'loose-file')].map(exists))).toEqual([
      true,
      true,
    ]);
  });

  test('a record whose id disagrees with its directory name is an orphan: kept while the directory is young', async () => {
    const id = await addRun('aaaaaa', 90);
    await writeRunRecord(
      join(runsDir, id),
      sampleRecord({ endedAt: '2020-01-01T00:00:00.000Z', runId: 'other' }),
    );
    expect((await applyRetention(runsDir, LIMITS, { now: NOW })).deleted).toEqual([]);
  });

  test('a symlink named like a run, and the directory it points to', async () => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeRunRecord(outside, sampleRecord({ endedAt: '2020-01-01T00:00:00.000Z' }));
    await writeFile(join(outside, 'precious'), 'keep me');
    await symlink(outside, join(runsDir, '2020-01-01T000000Z-aaaaaaaaa-linkdd'));
    const result = await applyRetention(runsDir, { maxAgeDays: 1, maxSizeGb: 0 }, { now: NOW });
    expect(result.deleted).toEqual([]);
    expect(await exists(join(outside, 'precious'))).toBe(true);
    expect(await exists(join(runsDir, '2020-01-01T000000Z-aaaaaaaaa-linkdd'))).toBe(true);
  });

  test('a symlink inside a run: the link goes, its target stays', async () => {
    const id = await addRun('aaaaaa', 90);
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'precious'), 'keep me');
    await symlink(outside, join(runsDir, id, 'link'));
    expect((await applyRetention(runsDir, LIMITS, { now: NOW })).deleted).toEqual([id]);
    expect(await exists(join(outside, 'precious'))).toBe(true);
  });

  test('a record file that is a symlink is not read: the run is an orphan, and its target stays', async () => {
    const id = await addRun('aaaaaa', 90);
    const real = join(root, 'real.json');
    await rename(join(runsDir, id, 'run.json'), real);
    await symlink(real, join(runsDir, id, 'run.json'));
    expect((await applyRetention(runsDir, LIMITS, { now: NOW })).deleted).toEqual([]);
    const old = new Date(NOW.getTime() - 90 * DAY);
    await utimes(join(runsDir, id), old, old);
    expect((await applyRetention(runsDir, LIMITS, { now: NOW })).deleted).toEqual([id]);
    expect(await exists(real)).toBe(true);
  });

  test('a missing runs directory is not an error', async () => {
    expect(await applyRetention(join(root, 'nope'), LIMITS, { now: NOW })).toEqual({ deleted: [] });
  });
});

describe('run directory names', () => {
  test('the name createRunDirectory gives a run is one retention and lookup recognise', async () => {
    const dir = await createRunDirectory(runsDir, NOW, 'a'.repeat(40));
    expect(basename(dir)).toMatch(RUN_DIRECTORY_NAME);
  });
});

describe('finding a run', () => {
  test('by exact id or by a unique prefix', async () => {
    const id = await addRun('aaaaaa', 1);
    await addRun('bbbbbb', 2);
    expect((await findRun(runsDir, id)).id).toBe(id);
    const byPrefix = await findRun(runsDir, id.slice(0, -2));
    expect(byPrefix.contents.kind === 'record' && byPrefix.contents.record.runId).toBe(id);
  });

  test('refuses an unknown id naming the runs directory, and an ambiguous prefix', async () => {
    await addRun('aaaaaa', 1);
    await addRun('bbbbbb', 2);
    const unknown = await rejectionOf(findRun(runsDir, 'nope'));
    expect(unknown).toBeInstanceOf(RunLookupError);
    expect(unknown.message).toContain(runsDir);
    expect((await rejectionOf(findRun(runsDir, '2026'))).message).toContain('matches 2 runs');
    expect((await rejectionOf(findRun(runsDir, ''))).message).toContain('No run');
  });

  test('a directory with no record is found as missing, one with a running record as a record', async () => {
    const orphan = await addOrphan('aaaaaa', 1);
    const running = await addRunning('bbbbbb', 1);
    expect((await findRun(runsDir, orphan)).contents).toEqual({ kind: 'missing' });
    expect((await findRun(runsDir, running)).contents.kind).toBe('record');
  });

  test('refuses a record that names another run, and a record that is a symlink', async () => {
    const id = await addRun('aaaaaa', 1);
    await writeRunRecord(
      join(runsDir, id),
      sampleRecord({ runId: '2026-10-01T000000Z-aaaaaaaaa-other1' }),
    );
    const mismatch = (await findRun(runsDir, id)).contents;
    expect(mismatch.kind === 'unusable' && mismatch.error.message).toContain('belongs to run');
    const linked = await addRun('bbbbbb', 1);
    const real = join(root, 'real.json');
    await rename(join(runsDir, linked, 'run.json'), real);
    await symlink(real, join(runsDir, linked, 'run.json'));
    const link = (await findRun(runsDir, linked)).contents;
    expect(link.kind === 'unusable' && link.error.message).toContain('not a regular file');
  });
});
