import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Host } from '@loomcli/core';

import { rejectionOf } from '../runs/testing';
import {
  acquireServeLock,
  createServeLockDeps,
  SERVE_LOCK_FILE,
  ServeLockError,
  TAKE_OVER_STALE_MS,
} from './lock';
import type { LockFiles, ServeLockDeps } from './lock';

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

/** `ps` says pid 50 runs another program and every other pid is a `hugi serve`. */
const notServe = async (pid: number) => (pid === 50 ? 'vim notes' : 'hugi serve');

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};
const writeLock = async (pid: number, boot = BOOT) => {
  await mkdir(dir, { recursive: true });
  await writeFile(lockPath(), JSON.stringify({ bootTime: boot, pid }));
};

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

const REAL_FILES: LockFiles = { link, mkdir, writeFile };

/** A starter whose take-over link finds that a rival has just linked its own lock. */
function rivalLinksFirst(rivalPid: number): LockFiles {
  let links = 0;
  return {
    ...REAL_FILES,
    link: async (from, to) => {
      links += 1;
      if (links === 2) {
        await writeLock(rivalPid);
      }
      await link(from, to);
    },
  };
}

test('a take-over whose link loses to another starter is refused, naming the winner', async () => {
  await writeLock(50);
  const refusal = await rejectionOf(
    acquireServeLock(dir, deps({ isAlive: (pid) => pid !== 50 }), rivalLinksFirst(77)),
  );
  expect(refusal).toBeInstanceOf(ServeLockError);
  expect(refusal.message).toContain('77');
  expect(JSON.parse(await readFile(lockPath(), 'utf8')).pid).toBe(77);
  expect(await readdir(dir)).toEqual([SERVE_LOCK_FILE]);
});

const mutexPath = () => `${lockPath()}.takeover`;

/** A starter for whom pid 50 is not alive. */
const dead = () => deps({ isAlive: (pid) => pid !== 50 });

describe('the take-over mutex', () => {
  test('is never made when the lock has a live holder', async () => {
    await writeLock(50);
    const made: string[] = [];
    const watched: LockFiles = {
      ...REAL_FILES,
      mkdir: async (path, options) => {
        made.push(path);
        return mkdir(path, options);
      },
    };
    expect(await rejectionOf(acquireServeLock(dir, deps(), watched))).toBeInstanceOf(
      ServeLockError,
    );
    expect(made).toEqual([]);
  });

  test('held by another starter refuses the take-over and is left alone', async () => {
    await writeLock(50);
    await mkdir(mutexPath());
    const refusal = await rejectionOf(acquireServeLock(dir, dead()));
    expect(refusal).toBeInstanceOf(ServeLockError);
    expect(refusal.message).toContain('taking over');
    expect((await stat(mutexPath())).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(lockPath(), 'utf8')).pid).toBe(50);
  });

  test('older than a minute is removed, and the take-over goes ahead', async () => {
    await writeLock(50);
    await mkdir(mutexPath());
    const old = new Date(Date.now() - TAKE_OVER_STALE_MS - 5000);
    await utimes(mutexPath(), old, old);
    await acquireServeLock(dir, dead());
    expect(JSON.parse(await readFile(lockPath(), 'utf8')).pid).toBe(100);
    expect(await readdir(dir)).toEqual([SERVE_LOCK_FILE]);
  });

  test('is removed when the take-over fails', async () => {
    await writeLock(50);
    const failing: LockFiles = {
      ...REAL_FILES,
      link: async (from, to) => {
        if (await exists(mutexPath())) {
          throw Object.assign(new Error('disk on fire'), { code: 'EIO' });
        }
        await link(from, to);
      },
    };
    expect((await rejectionOf(acquireServeLock(dir, dead(), failing))).message).toBe(
      'disk on fire',
    );
    // Neither the mutex nor this starter's temporary file is left; the stale lock was removed.
    expect(await readdir(dir)).toEqual([]);
  });
});

/** How an acquire ended: `held`, or the error it was refused with. */
const outcomeOf = async (acquire: Promise<unknown>): Promise<unknown> => {
  try {
    await acquire;
    return 'held';
  } catch (error) {
    return error;
  }
};

test('a starter never takes over a lock that is still being written', async () => {
  // This starter's write lands in two parts, and a rival starts between them.
  let rival: Promise<unknown> | undefined;
  const halting: LockFiles = {
    ...REAL_FILES,
    writeFile: async (path, text, options) => {
      await writeFile(path, '', options);
      rival ??= outcomeOf(acquireServeLock(dir, deps({ pid: 60 })));
      await rival;
      await writeFile(path, text, { ...options, flag: 'w' });
    },
  };
  const first = await outcomeOf(acquireServeLock(dir, deps(), halting));
  const outcomes = [first, await rival];
  expect(outcomes.filter((outcome) => outcome === 'held')).toHaveLength(1);
  const holder = first === 'held' ? 100 : 60;
  expect(JSON.parse(await readFile(lockPath(), 'utf8')).pid).toBe(holder);
});

test('a starter whose stale judgement another take-over overtakes does not also hold the lock', async () => {
  // pid 50 is alive but runs another program, so its lock is stale. While this starter asks ps
  // about pid 50, a rival takes the lock over completely.
  await writeLock(50);
  let rival: Promise<unknown> | undefined;
  const overtaken = async (pid: number) => {
    if (pid === 50) {
      rival ??= outcomeOf(acquireServeLock(dir, deps({ commandOf: notServe, pid: 60 })));
      await rival;
    }
    return notServe(pid);
  };
  const first = await outcomeOf(acquireServeLock(dir, deps({ commandOf: overtaken })));
  const outcomes = [first, await rival];
  expect(outcomes.filter((outcome) => outcome === 'held')).toHaveLength(1);
  const holder = first === 'held' ? 100 : 60;
  expect(JSON.parse(await readFile(lockPath(), 'utf8')).pid).toBe(holder);
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
  // By absolute path: a caller's PATH, or a configured `path`, may not reach /bin or /usr/sbin.
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
