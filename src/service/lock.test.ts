import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from '../runs/testing';
import { acquireServeLock, pidAlive, ServeLockError, serveLockHolder } from './lock';

/** The lock is darwin's `O_EXLOCK`, so a test of the real lock runs only there. */
const onDarwin = test.skipIf(process.platform !== 'darwin');

let scratch: string;
let dir: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'hugi-serve-lock-'));
  dir = join(scratch, 'hugi');
});
afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

const lockPath = () => join(dir, 'serve.lock');
const holder = (pid: number) => ({ pid, platform: 'darwin' });

onDarwin('takes the lock, recording its pid, in a private directory', async () => {
  const release = await acquireServeLock(lockPath(), holder(100));
  expect(await readFile(lockPath(), 'utf8')).toBe('100\n');
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  await release();
});

onDarwin(
  'a second take in the same process is refused, naming the holder, with exit 1',
  async () => {
    const release = await acquireServeLock(lockPath(), holder(100));
    const refusal = await rejectionOf(acquireServeLock(lockPath(), holder(200)));
    expect(refusal).toBeInstanceOf(ServeLockError);
    expect(refusal.message).toContain('pid 100');
    expect(ServeLockError.exitCode).toBe(1);
    await release();
  },
);

onDarwin(
  'a start that meets a lock held only for a moment, as by a status probe, waits and takes it',
  async () => {
    const brief = await acquireServeLock(lockPath(), holder(100));
    const waits: number[] = [];
    const release = await acquireServeLock(lockPath(), holder(200), async (ms) => {
      waits.push(ms);
      await brief();
    });
    expect(waits).toEqual([20]);
    expect(await readFile(lockPath(), 'utf8')).toBe('200\n');
    await release();
  },
);

onDarwin(
  'a start that meets a lock held throughout tries 10 times, 20 ms apart, then is refused',
  async () => {
    const held = await acquireServeLock(lockPath(), holder(100));
    const waits: number[] = [];
    const refusal = await rejectionOf(
      acquireServeLock(lockPath(), holder(200), async (ms) => {
        waits.push(ms);
      }),
    );
    expect(waits).toEqual(Array.from({ length: 9 }, () => 20));
    expect(refusal).toBeInstanceOf(ServeLockError);
    expect(refusal.message).toContain('pid 100');
    await held();
  },
);

onDarwin('release frees the lock for the next start, which records its own pid', async () => {
  const release = await acquireServeLock(lockPath(), holder(100));
  await release();
  const releaseNext = await acquireServeLock(lockPath(), holder(200));
  expect(await readFile(lockPath(), 'utf8')).toBe('200\n');
  await releaseNext();
});

/**
 * The source of a child that takes the lock at `path`, says so, and waits to be killed. It keeps the
 * release closure, as `startService` does: a dropped one lets the collector close the handle, and
 * with it the lock, which the forced collections before it says so would show.
 */
const childHolding = (path: string) => `
  const { acquireServeLock } = await import(${JSON.stringify(join(import.meta.dir, 'lock.ts'))});
  globalThis.release = await acquireServeLock(${JSON.stringify(path)}, { pid: process.pid, platform: 'darwin' });
  Bun.gc(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  Bun.gc(true);
  console.log('held');
  setInterval(() => {}, 60_000);
`;

onDarwin(
  'another process holding the lock refuses this one, and its kill -9 frees the lock',
  async () => {
    const child = Bun.spawn([process.execPath, '-e', childHolding(lockPath())], {
      stderr: 'inherit',
      stdout: 'pipe',
    });
    try {
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain('held');
      const refusal = await rejectionOf(acquireServeLock(lockPath(), holder(process.pid)));
      expect(refusal).toBeInstanceOf(ServeLockError);
      expect(refusal.message).toContain(`pid ${child.pid}`);
      expect(await serveLockHolder(lockPath(), 'darwin')).toBe(child.pid);
    } finally {
      // oxlint-disable-next-line @loomcli/host-bypass -- the test kills its own child
      process.kill(child.pid, 'SIGKILL');
      await child.exited;
    }
    expect(await serveLockHolder(lockPath(), 'darwin')).toBeUndefined();
    const release = await acquireServeLock(lockPath(), holder(process.pid));
    await release();
  },
);

test('off darwin the service refuses to start, since it runs only on macOS', async () => {
  const refusal = await rejectionOf(acquireServeLock(lockPath(), { pid: 1, platform: 'linux' }));
  expect(refusal).toBeInstanceOf(ServeLockError);
  expect(refusal.message).toContain('only on macOS');
});

onDarwin('the lock holder is the live pid written by the process that holds the lock', async () => {
  const release = await acquireServeLock(lockPath(), holder(process.pid));
  expect(await serveLockHolder(lockPath(), 'darwin')).toBe(process.pid);
  await release();
});

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, '-e', '']);
  await child.exited;
  return child.pid;
}

test('a pid is alive while its process runs, including one this user may not signal', async () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(1)).toBe(true);
  expect(pidAlive(await deadPid())).toBe(false);
});

onDarwin('a held lock whose recorded pid is dead has no live holder', async () => {
  const dead = await deadPid();
  const release = await acquireServeLock(lockPath(), holder(dead));
  expect(await serveLockHolder(lockPath(), 'darwin')).toBeUndefined();
  await release();
});

onDarwin('a held lock that records no pid yet has no holder', async () => {
  const release = await acquireServeLock(lockPath(), holder(process.pid));
  await writeFile(lockPath(), '');
  expect(await serveLockHolder(lockPath(), 'darwin')).toBeUndefined();
  await release();
});

onDarwin('a lock file nobody holds has no holder, whatever pid it records', async () => {
  const release = await acquireServeLock(lockPath(), holder(42));
  await release();
  expect(await readFile(lockPath(), 'utf8')).toBe('42\n');
  expect(await serveLockHolder(lockPath(), 'darwin')).toBeUndefined();
  // The look took the lock for a moment only: a start still finds it free.
  const releaseNext = await acquireServeLock(lockPath(), holder(43));
  await releaseNext();
});

test('no lock file, or no darwin, means no holder', async () => {
  expect(await serveLockHolder(lockPath(), process.platform)).toBeUndefined();
  expect(await serveLockHolder(lockPath(), 'linux')).toBeUndefined();
});
