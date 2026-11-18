/**
 * The runner's short guest and tart calls that are not a step: polling a
 * step's status, copying its log, killing it, stopping the VM. Each runs under
 * a short deadline of its own, so a wedged guest agent or tart process cannot
 * hold a run open; a call that misses its deadline counts as failed.
 */
import { withDeadline } from './deadline';
import type { Deadlined } from './deadline';
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

/** The pieces a guest housekeeping call needs. */
export type GuestCall = {
  readonly tart: Tart;
  readonly clock: Clock;
  readonly vm: string;
  readonly deadlineMs: number;
};

/**
 * Copy a guest file to `write` as it arrives, so a large log is never held whole: nothing is
 * written when it does not exist, and `ok: false` when the guest agent failed to answer in time.
 */
export async function copyGuestFile(
  call: GuestCall,
  path: string,
  write: (chunk: string) => void,
  parent?: AbortSignal,
): Promise<Deadlined<void>> {
  return withDeadline(
    call.clock,
    call.deadlineMs,
    async (signal) => {
      const { exitCode } = await call.tart.exec(call.vm, readFileArgv(path), {
        onOutput: write,
        signal,
      });
      if (exitCode !== 0) {
        throw new Error(`reading ${path} exited ${exitCode}`);
      }
    },
    { parent, waitForWork: false },
  );
}

/**
 * Read a small guest file, such as a status or command file: its text, `''` when it does not
 * exist, or `ok: false` when the guest agent failed to answer in time.
 */
export async function readGuestFile(
  call: GuestCall,
  path: string,
  parent?: AbortSignal,
): Promise<Deadlined<string>> {
  let text = '';
  const copied = await copyGuestFile(
    call,
    path,
    (chunk) => {
      text += chunk;
    },
    parent,
  );
  return copied.ok ? { ...copied, value: text } : copied;
}

/** Kill the process group a step recorded; `ok: false` when the guest did not confirm it in time. */
export async function killProcessGroup(
  call: GuestCall,
  processGroupFile: string,
): Promise<Deadlined<void>> {
  return withDeadline(
    call.clock,
    call.deadlineMs,
    async (signal) => {
      const { exitCode } = await call.tart.exec(call.vm, killGroupArgv(processGroupFile), {
        signal,
      });
      if (exitCode !== 0) {
        throw new Error(`the kill exited ${exitCode}`);
      }
    },
    { waitForWork: false },
  );
}
