/**
 * The single-instance lock of `hugi serve`: `serve.lock` in Hugi's state directory, recording the
 * holder's pid and the boot time. A lock is stale, and taken over, when the machine has rebooted
 * since, its pid is not alive, or the live pid is not a `hugi serve`. Every process fact comes in
 * through `ServeLockDeps`, so tests need no real process.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FatalError } from '@loomcli/core';
import type { Host } from '@loomcli/core';

import { isMapping } from '../yaml/strict';
import { errnoCode } from './errno';

/** The lock's file name inside the state directory. */
export const SERVE_LOCK_FILE = 'serve.lock';

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

/** The file operation the take-over uses; the seam a test replaces to stage a rival. */
export type LockFiles = { readonly rename: (from: string, to: string) => Promise<void> };

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

function refusal(pid: number | undefined, dir: string): ServeLockError {
  const holder = pid === undefined ? 'another hugi serve' : `hugi serve (pid ${pid})`;
  return new ServeLockError(
    `${holder} already runs for this user, so this one will not start. ` +
      `Stop it, or remove ${join(dir, SERVE_LOCK_FILE)} if no service is running.`,
  );
}

const REAL_FILES: LockFiles = { rename };

/**
 * Take the lock, or throw a `ServeLockError` naming the holder. The lock is created exclusively;
 * a stale one is replaced by renaming a temporary file over it, then read back, so two starters
 * taking over at once cannot both keep it. Returns `release`, which deletes the lock only while
 * it still holds this pid.
 */
export async function acquireServeLock(
  dir: string,
  deps: ServeLockDeps,
  files: LockFiles = REAL_FILES,
): Promise<() => Promise<void>> {
  await mkdir(dir, { mode: 0o700, recursive: true });
  const path = join(dir, SERVE_LOCK_FILE);
  const boot = await deps.bootTime();
  const text = `${JSON.stringify({ bootTime: boot, pid: deps.pid })}\n`;
  const release = async (): Promise<void> => {
    if ((await readLock(path))?.pid === deps.pid) {
      await rm(path, { force: true });
    }
  };

  try {
    await writeFile(path, text, { flag: 'wx', mode: 0o600 });
    return release;
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') {
      throw error;
    }
  }

  const held = await readLock(path);
  if (held !== undefined && (await isHeld(held, boot, deps))) {
    throw refusal(held.pid, dir);
  }
  const temporary = join(dir, `.${SERVE_LOCK_FILE}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await files.rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const winner = await readLock(path);
  if (winner?.pid !== deps.pid) {
    throw refusal(winner?.pid, dir);
  }
  return release;
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
 * Programs start through the run's `host.spawn`, by absolute path: a launchd agent's bare `PATH`
 * does not hold `/usr/sbin`, and a boot time one starter could read and another could not would
 * otherwise make a held lock look stale.
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
