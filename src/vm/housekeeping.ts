/**
 * The runner's short guest and tart calls that are not a step: polling a
 * step's status, copying its log, killing it, stopping the VM. Each runs under
 * a short deadline of its own, so a wedged guest agent or tart process cannot
 * hold a run open; a call that misses its deadline counts as failed.
 */
import type { Clock, Tart } from './tart';

/** The marker argument that names each guest command, for `ps` and for the test fake. */
export const READ_FILE_MARKER = 'hugi-read';
export const KILL_GROUP_MARKER = 'hugi-kill';

/** Prints the file, or nothing when it does not exist; exits 0 either way while the agent works. */
export function readFileArgv(path: string): string[] {
  return ['sh', '-c', 'test ! -e "$1" || exec cat "$1"', READ_FILE_MARKER, path];
}

/** Grace a timed-out step gets between SIGTERM and SIGKILL, in half-second polls. */
const KILL_GRACE_POLLS = 10;

/**
 * Signals the process group named in the file: SIGTERM, then SIGKILL once a
 * short grace passes with any member still alive. Exits 0 when there is no
 * group to kill.
 */
export function killGroupArgv(processGroupFile: string): string[] {
  const script = [
    'pg=$(cat "$1" 2>/dev/null) || exit 0',
    'kill -TERM -- "-$pg" 2>/dev/null || exit 0',
    'i=0',
    `while [ $i -lt ${KILL_GRACE_POLLS} ]; do kill -0 -- "-$pg" 2>/dev/null || exit 0; sleep 0.5; i=$((i+1)); done`,
    'kill -KILL -- "-$pg" 2>/dev/null',
    'exit 0',
  ].join('\n');
  return ['sh', '-c', script, KILL_GROUP_MARKER, processGroupFile];
}

export type Bounded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly why: string };

/**
 * Run `work` for at most `milliseconds`. Its signal aborts at the deadline, or
 * when `parent` aborts; the result does not wait on a call that ignores its
 * signal. A throw or a missed deadline is `ok: false` with the reason.
 */
export async function bounded<T>(
  clock: Clock,
  milliseconds: number,
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<Bounded<T>> {
  const call = new AbortController();
  const timer = new AbortController();
  const abortCall = (): void => call.abort();
  if (parent?.aborted) {
    abortCall();
  }
  parent?.addEventListener('abort', abortCall, { once: true });
  const attempt = async (): Promise<Bounded<T>> => {
    try {
      return { ok: true, value: await work(call.signal) };
    } catch (error) {
      return { ok: false, why: error instanceof Error ? error.message : String(error) };
    }
  };
  const deadline = async (): Promise<Bounded<T>> => {
    const elapsed = await clock.sleep(milliseconds, timer.signal);
    call.abort();
    return { ok: false, why: elapsed ? `no answer within ${milliseconds / 1000}s` : 'cancelled' };
  };
  try {
    return await Promise.race([attempt(), deadline()]);
  } finally {
    timer.abort();
    parent?.removeEventListener('abort', abortCall);
  }
}

/** The pieces a guest housekeeping call needs. */
export type GuestCall = {
  readonly tart: Tart;
  readonly clock: Clock;
  readonly vm: string;
  readonly deadlineMs: number;
};

/**
 * Read a guest file: its text, `''` when it does not exist, or `ok: false` when
 * the guest agent failed to answer in time.
 */
export async function readGuestFile(
  call: GuestCall,
  path: string,
  parent?: AbortSignal,
): Promise<Bounded<string>> {
  return bounded(
    call.clock,
    call.deadlineMs,
    async (signal) => {
      let text = '';
      const { exitCode } = await call.tart.exec(call.vm, readFileArgv(path), {
        onOutput: (chunk) => {
          text += chunk;
        },
        signal,
      });
      if (exitCode !== 0) {
        throw new Error(`reading ${path} exited ${exitCode}`);
      }
      return text;
    },
    parent,
  );
}

/** Kill the process group a step recorded; `ok: false` when the guest did not confirm it in time. */
export async function killProcessGroup(
  call: GuestCall,
  processGroupFile: string,
): Promise<Bounded<void>> {
  return bounded(call.clock, call.deadlineMs, async (signal) => {
    const { exitCode } = await call.tart.exec(call.vm, killGroupArgv(processGroupFile), {
      signal,
    });
    if (exitCode !== 0) {
      throw new Error(`the kill exited ${exitCode}`);
    }
  });
}
