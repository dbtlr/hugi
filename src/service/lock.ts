/**
 * The single-instance lock of `hugi serve` (`resolveServeLockPath`), recording the holder's pid and
 * the boot time. A lock is stale, and taken over, when the machine has rebooted
 * since, its pid is not alive, or the live pid is not a `hugi serve`. Every process fact comes in
 * through `ServeLockDeps`, so tests need no real process.
 */
import { link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { FatalError } from '@loomcli/core';
import type { Host } from '@loomcli/core';

import { temporaryPathFor } from '../atomic-write';
import { errnoCode } from '../errno';
import { isMapping } from '../yaml/strict';

/** Exit 1: another `hugi serve` holds the lock, or won a take-over. */
export class ServeLockError extends FatalError {
  override readonly name = 'ServeLockError';
  static override readonly exitCode = 1;
}

/** What the lock needs to know about processes and the machine. */
export type ServeLockDeps = {
  /** This process's pid. */
  readonly pid: number;
  /** A word that changes at each reboot. */
  readonly bootTime: () => Promise<string>;
  readonly isAlive: (pid: number) => boolean;
  /** The command line of `pid`, or `undefined` when it cannot be read. */
  readonly commandOf: (pid: number) => Promise<string | undefined>;
};

/** The file operations a starter's own steps use; the seam a test replaces to stage a rival between them. */
export type LockFiles = {
  /** Writes this starter's lock to its temporary file, before the file is linked as the lock. */
  readonly writeFile: (
    path: string,
    text: string,
    options: { readonly mode: number },
  ) => Promise<void>;
  /** Links the temporary file as the lock; fails with `EEXIST` when a lock exists. */
  readonly link: (from: string, to: string) => Promise<void>;
  /** Creates the take-over mutex; fails with `EEXIST` when it exists. */
  readonly mkdir: (path: string, options: { readonly mode: number }) => Promise<unknown>;
};

type LockContents = { readonly pid: number; readonly bootTime: string };

function parseLock(text: string): LockContents | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isMapping(parsed)) {
      return undefined;
    }
    const { bootTime, pid } = parsed;
    return typeof pid === 'number' && Number.isSafeInteger(pid) && typeof bootTime === 'string'
      ? { bootTime, pid }
      : undefined;
  } catch {
    return undefined;
  }
}

async function readLock(path: string): Promise<LockContents | undefined> {
  try {
    return parseLock(await readFile(path, 'utf8'));
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

const isServeCommand = (command: string): boolean =>
  command.includes('serve') && command.includes('hugi');

/** The boot time when it cannot be read; it proves nothing, so it never makes a lock stale. */
const UNKNOWN_BOOT = 'unknown';

/** How far two readings of one boot's time may differ: macOS adjusts it as the clock is corrected. */
const BOOT_DRIFT_SECONDS = 60;

/** The boot's seconds from `sysctl -n kern.boottime` (`{ sec = N, usec = M } …`), if it reads as one. */
function bootSeconds(boot: string): number | undefined {
  const match = /\bsec = (\d+)/u.exec(boot);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Whether two boot times are from different boots. Only the seconds count, within a drift, since
 * the microseconds change between readings; a time either side could not read decides nothing.
 */
function isOtherBoot(held: string, current: string): boolean {
  const [a, b] = [bootSeconds(held), bootSeconds(current)];
  return a !== undefined && b !== undefined && Math.abs(a - b) > BOOT_DRIFT_SECONDS;
}

/**
 * Whether `held` is a live `hugi serve` of this boot. A boot time either side could not read
 * leaves the decision to the pid and its command. A live pid whose command cannot be read is
 * treated as live, so an unreadable `ps` never lets a second service start.
 */
async function isHeld(held: LockContents, boot: string, deps: ServeLockDeps): Promise<boolean> {
  if (isOtherBoot(held.bootTime, boot) || !deps.isAlive(held.pid)) {
    return false;
  }
  const command = await deps.commandOf(held.pid);
  return command === undefined || isServeCommand(command);
}

function refusal(pid: number | undefined, path: string): ServeLockError {
  const holder = pid === undefined ? 'another hugi serve' : `hugi serve (pid ${pid})`;
  return new ServeLockError(
    `${holder} already runs for this user, so this one will not start. ` +
      `Stop it, or remove ${path} if no service is running.`,
  );
}

/** The take-over mutex beside the lock: a directory, since `mkdir` creates one atomically. */
const takeOverMutex = (path: string) => `${path}.takeover`;

/** How old a take-over mutex may be before it is judged left by a starter that died in a take-over. */
export const TAKE_OVER_STALE_MS = 60_000;

function takeOverRefusal(mutex: string): ServeLockError {
  return new ServeLockError(
    `Another hugi serve is taking over the lock now, so this one will not start. ` +
      `If none is starting, remove ${mutex}.`,
  );
}

const REAL_FILES: LockFiles = { link, mkdir, writeFile };

/** Run `create`, which fails with `EEXIST` when its target exists: true when it did not exist. */
async function created(create: () => Promise<unknown>): Promise<boolean> {
  try {
    await create();
    return true;
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

/** Milliseconds since `path` was last modified, or `undefined` when it is gone. */
async function ageOf(path: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Create the take-over mutex, or throw when another starter holds it. A mutex older than
 * `TAKE_OVER_STALE_MS` was left by a starter that died while taking over; it is removed once, and
 * a starter that still cannot create the mutex then is refused.
 */
async function enterTakeOver(mutex: string, files: LockFiles): Promise<void> {
  const make = () => files.mkdir(mutex, { mode: 0o700 });
  if (await created(make)) {
    return;
  }
  const age = await ageOf(mutex);
  if (age !== undefined && age <= TAKE_OVER_STALE_MS) {
    throw takeOverRefusal(mutex);
  }
  await rm(mutex, { force: true, recursive: true });
  if (!(await created(make))) {
    throw takeOverRefusal(mutex);
  }
}

/** Refuse when the lock at `path` is held by a live `hugi serve` of this boot. */
async function refuseIfHeld(path: string, boot: string, deps: ServeLockDeps) {
  const held = await readLock(path);
  if (held !== undefined && (await isHeld(held, boot, deps))) {
    throw refusal(held.pid, path);
  }
}

/**
 * Take over a lock judged stale. Take-overs are serialized by the mutex; under it the lock is read
 * and judged again, since another starter may have taken it over since, then removed and replaced
 * by linking this starter's file. A link that still finds a lock lost to a starter that created
 * one meanwhile, and is refused, naming it.
 */
async function takeOver(
  path: string,
  temporary: string,
  boot: string,
  deps: ServeLockDeps,
  files: LockFiles,
): Promise<void> {
  const mutex = takeOverMutex(path);
  await enterTakeOver(mutex, files);
  try {
    await refuseIfHeld(path, boot, deps);
    await rm(path, { force: true });
    if (!(await created(() => files.link(temporary, path)))) {
      throw refusal((await readLock(path))?.pid, path);
    }
  } finally {
    await rm(mutex, { force: true, recursive: true });
  }
}

/**
 * Take the lock, or throw a `ServeLockError` naming the holder. The lock's text is written to a
 * temporary file first and then linked as the lock, which is atomic and fails when the lock
 * exists, so no starter ever reads a lock that is half written. A live holder is refused at once;
 * a stale lock is taken over under the take-over mutex (`takeOver`), so two starters can never
 * both hold it. Returns `release`, which deletes the lock only while it still holds this pid.
 */
export async function acquireServeLock(
  path: string,
  deps: ServeLockDeps,
  files: LockFiles = REAL_FILES,
): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const boot = await deps.bootTime();
  const temporary = temporaryPathFor(path);
  try {
    await files.writeFile(temporary, `${JSON.stringify({ bootTime: boot, pid: deps.pid })}\n`, {
      mode: 0o600,
    });
    if (!(await created(() => files.link(temporary, path)))) {
      await refuseIfHeld(path, boot, deps);
      await takeOver(path, temporary, boot, deps, files);
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return async () => {
    if ((await readLock(path))?.pid === deps.pid) {
      await rm(path, { force: true });
    }
  };
}

type Spawn = Host['spawn'];

/** Run a command and return its trimmed stdout, or `undefined` when it fails or prints nothing. */
async function output(
  spawn: Spawn,
  command: string,
  args: readonly string[],
): Promise<string | undefined> {
  const exit = await spawn(command, args).exited;
  if (exit.kind !== 'exited' || exit.code !== 0) {
    return undefined;
  }
  const text = exit.stdout.text.trim();
  return text === '' ? undefined : text;
}

/** `process.kill(pid, 0)`: `EPERM` means the process exists but belongs to someone else. */
function processIsAlive(pid: number): boolean {
  try {
    // Host has no way to signal a process, and the lock needs only this existence probe.
    // oxlint-disable-next-line @loomcli/host-bypass
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'EPERM') {
      return true;
    }
    if (code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

/**
 * The real deps: `kill(pid, 0)` for liveness, `sysctl -n kern.boottime` on darwin for the boot
 * time (a fixed word elsewhere, where Hugi's VM host never runs), and `ps` for a command line.
 * Programs start through the run's `host.spawn`, by absolute path. launchd's default `PATH`,
 * `/usr/bin:/bin:/usr/sbin:/sbin`, holds both, but a caller's `PATH`, or a configured `path`, may
 * not; and a boot time one starter could read and another could not would make a held lock look
 * stale.
 */
export function createServeLockDeps(
  spawn: Spawn,
  from: { readonly pid: number; readonly platform: string },
): ServeLockDeps {
  return {
    bootTime: async () =>
      from.platform === 'darwin'
        ? ((await output(spawn, '/usr/sbin/sysctl', ['-n', 'kern.boottime'])) ?? UNKNOWN_BOOT)
        : UNKNOWN_BOOT,
    commandOf: (pid) => output(spawn, '/bin/ps', ['-p', String(pid), '-o', 'command=']),
    isAlive: processIsAlive,
    pid: from.pid,
  };
}
