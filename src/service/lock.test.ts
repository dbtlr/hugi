import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rename, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Host } from '@loomcli/core';

import { acquireServeLock, createServeLockDeps, SERVE_LOCK_FILE, ServeLockError } from './lock';
import type { ServeLockDeps } from './lock';

let scratch: string;
let dir: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'hugi-serve-lock-'));
  dir = join(scratch, 'hugi');
});
afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

const BOOT = '{ sec = 1788622746, usec = 311837 } Sat Sep  5 11:39:06 2026';

function deps(overrides: Partial<ServeLockDeps> = {}): ServeLockDeps {
  return {
    bootTime: async () => BOOT,
    commandOf: async () => '/usr/local/bin/hugi serve',
    isAlive: () => true,
    pid: 100,
    ...overrides,
  };
}

const lockPath = () => join(dir, SERVE_LOCK_FILE);
const writeLock = (pid: number, boot = BOOT) =>
  writeFile(lockPath(), JSON.stringify({ bootTime: boot, pid }));

test('with no lock it takes one recording its pid and the boot time, in a private directory', async () => {
  await acquireServeLock(dir, deps());
  expect(JSON.parse(await readFile(lockPath(), 'utf8'))).toEqual({ bootTime: BOOT, pid: 100 });
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
});

test('a lock held by a live hugi serve is refused, naming its pid, with exit 1', async () => {
  await acquireServeLock(dir, deps({ pid: 50 }));
  const refusal = await acquireServeLock(dir, deps()).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(ServeLockError);
  expect(refusal instanceof Error && refusal.message).toContain('50');
  expect(ServeLockError.exitCode).toBe(1);
  expect(JSON.parse(await readFile(lockPath(), 'utf8')).pid).toBe(50);
});

test('a live hugi serve keeps the lock when the boot time drifts by microseconds', async () => {
  await acquireServeLock(dir, deps({ pid: 50 }));
  const drifted = '{ sec = 1788622746, usec = 195373 } Sat Sep  5 11:39:06 2026';
  const refusal = await acquireServeLock(dir, deps({ bootTime: async () => drifted })).catch(
    (error: unknown) => error,
  );
  expect(refusal).toBeInstanceOf(ServeLockError);
});

test.each([
  ['its holder could not read the boot time', 'unknown'],
  ['this starter cannot read the boot time', BOOT],
])('a live hugi serve keeps the lock when %s', async (_name, holderBoot) => {
  await acquireServeLock(dir, deps({ bootTime: async () => holderBoot, pid: 50 }));
  const starterBoot = holderBoot === 'unknown' ? BOOT : 'unknown';
  const refusal = await acquireServeLock(dir, deps({ bootTime: async () => starterBoot })).catch(
    (error: unknown) => error,
  );
  expect(refusal).toBeInstanceOf(ServeLockError);
  expect(JSON.parse(await readFile(lockPath(), 'utf8')).pid).toBe(50);
});

test.each([
  [
    'it is from another boot',
    { bootTime: async () => '{ sec = 1788700000, usec = 1 } Sun Sep  6 09:06:40 2026' },
  ],
  ['its pid is not alive', { isAlive: () => false }],
  ['the live pid is another program', { commandOf: async () => '/usr/bin/vim hugi-notes' }],
  [
    'the live pid runs hugi with another command',
    { commandOf: async () => 'hugi run ci.yml:test' },
  ],
])('a lock is taken over when %s', async (_name, override) => {
  await acquireServeLock(dir, deps({ pid: 50 }));
  await acquireServeLock(dir, deps({ pid: 100, ...override }));
  expect(JSON.parse(await readFile(lockPath(), 'utf8')).pid).toBe(100);
  expect(await readdir(dir)).toEqual([SERVE_LOCK_FILE]);
});

test('a live pid whose command cannot be read is not taken from', async () => {
  await acquireServeLock(dir, deps({ pid: 50 }));
  const refusal = await acquireServeLock(dir, deps({ commandOf: async () => undefined })).catch(
    (error: unknown) => error,
  );
  expect(refusal).toBeInstanceOf(ServeLockError);
});

test.each([
  ['not JSON', '{nope'],
  ['no pid', '{"bootTime":"boot-1"}'],
  ['empty', ''],
])('a lock file that is %s is taken over', async (_name, text) => {
  await acquireServeLock(dir, deps({ pid: 50 }));
  await writeFile(lockPath(), text);
  await acquireServeLock(dir, deps());
  expect(JSON.parse(await readFile(lockPath(), 'utf8')).pid).toBe(100);
});

test('a take-over that another starter overwrites is refused, naming the winner', async () => {
  await acquireServeLock(dir, deps({ pid: 50 }));
  // The starter renames its lock over the stale one; a rival renames its own over that at once.
  const rivalWins = {
    rename: async (from: string, to: string) => {
      await rename(from, to);
      await writeLock(77);
    },
  };
  const refusal = await acquireServeLock(
    dir,
    deps({ isAlive: (pid) => pid !== 50 }),
    rivalWins,
  ).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(ServeLockError);
  expect(refusal instanceof Error && refusal.message).toContain('77');
  expect(JSON.parse(await readFile(lockPath(), 'utf8')).pid).toBe(77);
});

test('release deletes the lock only while it still holds this pid', async () => {
  const release = await acquireServeLock(dir, deps());
  await release();
  expect(await readdir(dir)).toEqual([]);

  const again = await acquireServeLock(dir, deps());
  await writeLock(9);
  await again();
  expect(JSON.parse(await readFile(lockPath(), 'utf8')).pid).toBe(9);
});

test('release is harmless when the lock is already gone', async () => {
  const release = await acquireServeLock(dir, deps());
  await rm(lockPath());
  await release();
});

type Reply = { code: number; text: string };

function fakeSpawn(replies: Record<string, Reply>) {
  const calls: string[] = [];
  const spawn = ((command: string, args: readonly string[]) => {
    const key = [command, ...args].join(' ');
    calls.push(key);
    const reply = replies[key] ?? { code: 1, text: '' };
    const output = { bytes: new TextEncoder().encode(reply.text), text: reply.text };
    return {
      exited: Promise.resolve({ code: reply.code, kind: 'exited', stderr: output, stdout: output }),
      kill: () => undefined,
    };
  }) as Host['spawn'];
  return { calls, spawn };
}

test('production deps read the darwin boot time from sysctl and the command from ps', async () => {
  const { calls, spawn } = fakeSpawn({
    '/bin/ps -p 321 -o command=': { code: 0, text: '/opt/hugi serve\n' },
    '/usr/sbin/sysctl -n kern.boottime': { code: 0, text: '{ sec = 1700000000, usec = 5 } Tue\n' },
  });
  const real = createServeLockDeps(spawn, { pid: 1, platform: 'darwin' });
  expect(await real.bootTime()).toBe('{ sec = 1700000000, usec = 5 } Tue');
  expect(await real.commandOf(321)).toBe('/opt/hugi serve');
  // By absolute path: a launchd agent's bare PATH, or a configured `path`, may not reach /usr/sbin.
  expect(calls).toEqual(['/usr/sbin/sysctl -n kern.boottime', '/bin/ps -p 321 -o command=']);
});

test('production commandOf is undefined when ps fails or prints nothing', async () => {
  const real = createServeLockDeps(fakeSpawn({}).spawn, { pid: 1, platform: 'darwin' });
  expect(await real.commandOf(321)).toBeUndefined();
});

test('production isAlive is true for this process, false for a pid that cannot exist', () => {
  const real = createServeLockDeps(fakeSpawn({}).spawn, { pid: process.pid, platform: 'darwin' });
  expect(real.isAlive(process.pid)).toBe(true);
  expect(real.isAlive(2 ** 22 + 12345)).toBe(false);
});

test('off darwin the boot time is a fixed word, so only the other checks decide', async () => {
  const real = createServeLockDeps(fakeSpawn({}).spawn, { pid: 1, platform: 'linux' });
  expect(await real.bootTime()).toBe('unknown');
});
