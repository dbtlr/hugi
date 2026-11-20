import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createRunDirectory,
  resolveCacheDir,
  resolveRunsDir,
  resolveServiceStateDir,
  runDirectoryName,
} from './locations';

test('the cache directory prefers the flag, then HUGI_CACHE_DIR, then the XDG cache, then ~/.cache', () => {
  const env = { HUGI_CACHE_DIR: '/env', XDG_CACHE_HOME: '/xdg' };
  expect(resolveCacheDir('/flag', env, '/home/u')).toBe('/flag');
  expect(resolveCacheDir(undefined, env, '/home/u')).toBe('/env');
  expect(resolveCacheDir(undefined, { XDG_CACHE_HOME: '/xdg' }, '/home/u')).toBe('/xdg/hugi');
  expect(resolveCacheDir(undefined, { XDG_CACHE_HOME: '' }, '/home/u')).toBe('/home/u/.cache/hugi');
});

test('runs live under the XDG state directory, else ~/.local/state', () => {
  expect(resolveRunsDir({ XDG_STATE_HOME: '/state' }, '/home/u')).toBe('/state/hugi/runs');
  expect(resolveRunsDir({}, '/home/u')).toBe('/home/u/.local/state/hugi/runs');
});

test('the service state directory is hugi under the XDG state home, else ~/.local/state', () => {
  expect(resolveServiceStateDir({ XDG_STATE_HOME: '/state' }, '/home/u')).toBe('/state/hugi');
  expect(resolveServiceStateDir({ XDG_STATE_HOME: '' }, '/home/u')).toBe(
    '/home/u/.local/state/hugi',
  );
});

test('a run directory name sorts by time and carries the short commit', () => {
  expect(runDirectoryName(new Date('2026-11-18T01:02:03.456Z'), '7e71dfe81abcdef')).toBe(
    '2026-11-18T010203Z-7e71dfe81',
  );
});

test('two runs of one commit in the same second get distinct, freshly created log directories', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hugi-locations-'));
  try {
    const runs = join(scratch, 'state', 'runs');
    const now = new Date('2026-11-18T01:02:03.456Z');
    const one = await createRunDirectory(runs, now, '7e71dfe81abcdef');
    const two = await createRunDirectory(runs, now, '7e71dfe81abcdef');
    expect(one).not.toBe(two);
    expect(one.startsWith(join(runs, '2026-11-18T010203Z-7e71dfe81-'))).toBe(true);
    expect((await stat(one)).isDirectory()).toBe(true);
    expect((await stat(two)).isDirectory()).toBe(true);
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
});
