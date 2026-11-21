/**
 * The one place Hugi starts a `tart` process. Every call has a deadline (the long-lived `tart run`
 * excepted, which ends only when told to), and a call that runs past it, or that its caller aborts,
 * gets SIGTERM, then SIGKILL after a grace period, so a wedged tart or guest agent cannot hold a run
 * open or keep a VM from being deleted. The result is a typed `TartOutcome`, never an exception.
 */
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import type { ChildExit, Host } from '@loomcli/core';

import { resolvesWithin, withDeadline } from './deadline';
import type { Clock } from './tart';

type Spawn = Host['spawn'];

/** How long a tart process gets to exit after SIGTERM before it is sent SIGKILL. */
export const TART_TERM_GRACE_MS = 5000;
/** How long to wait for the exit after SIGKILL before giving up on reaping it. */
export const TART_KILL_WAIT_MS = 2000;
/** The longest a call can run past its deadline: the grace after SIGTERM, then the wait after SIGKILL. */
export const TART_ESCALATION_MS = TART_TERM_GRACE_MS + TART_KILL_WAIT_MS;

/** A clone copies a local image in seconds but may pull one from a registry: generous, still finite. */
export const TART_CLONE_DEADLINE_MS = 20 * 60_000;
/** `tart set` edits one config file; anything past this is a wedged tart. */
export const TART_SET_DEADLINE_MS = 30_000;
/** `tart stop` forces the VM off after its own 10-second timeout; this leaves it a margin. */
export const TART_STOP_DEADLINE_MS = 20_000;
/** `tart list` reads a directory of small config files. */
export const TART_LIST_DEADLINE_MS = 30_000;
/** `tart delete` removes a stopped VM's files, which takes seconds. */
export const TART_DELETE_DEADLINE_MS = 20_000;
/**
 * The ceiling on one `tart exec`. Callers bound their execs far tighter (the job timeout, the
 * housekeeping deadline) by aborting; this only stops an exec that nobody bounds. It is GitHub's
 * 6-hour job limit plus an hour.
 */
export const TART_EXEC_DEADLINE_MS = 7 * 3_600_000;

/** The longest delay a timer takes; the stand-in deadline of a process that has none. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const OUTPUT_TAIL_CHARS = 8192;
const ABORTED_EXIT_CODE = 143;
const KILLED_EXIT_CODE = 137;

/** Why a call was cut short: its deadline passed, or its caller aborted. */
export type EndCause = 'deadline' | 'abort';

type Ended = { readonly exitCode: number; readonly output: string };

/** How one tart call ended. */
export type TartOutcome =
  | ({ readonly kind: 'completed' } & Ended)
  | { readonly kind: 'unstarted'; readonly error: Error }
  /** The deadline passed and the process exited on SIGTERM. */
  | ({ readonly kind: 'timed-out'; readonly cause: 'deadline' } & Ended)
  /** The caller aborted and the process exited on SIGTERM. */
  | ({ readonly kind: 'aborted'; readonly cause: 'abort' } & Ended)
  /** The process ignored SIGTERM and was sent SIGKILL. */
  | ({ readonly kind: 'killed'; readonly cause: EndCause } & Ended);

export type TartCallOptions = {
  /** Without one the process runs until it exits or `terminate` is called. */
  readonly deadlineMs?: number;
  /** Aborting sends SIGTERM, then SIGKILL after the grace period. */
  readonly signal?: AbortSignal;
  readonly stdin?: string;
  /** Receives the process's combined stdout and stderr as it arrives. */
  readonly onOutput?: (chunk: string) => void;
};

export type TartCall = {
  readonly outcome: Promise<TartOutcome>;
  /** Ask the process to end: SIGTERM, then SIGKILL after the grace period. */
  readonly terminate: () => void;
};

/**
 * A writable that hands its bytes to `onText` as UTF-8 text. One decoder per stream holds back a
 * character split across two chunks until the rest arrives.
 */
export function textSink(onText: (text: string) => void): Writable {
  const decoder = new StringDecoder('utf8');
  return new Writable({
    final(done) {
      const rest = decoder.end();
      if (rest !== '') {
        onText(rest);
      }
      done();
    },
    write(chunk: Buffer | string, _encoding, done) {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (text !== '') {
        onText(text);
      }
      done();
    },
  });
}

/** How the process ended under supervision. */
type Supervised =
  | { readonly ended: 'exited'; readonly exit: ChildExit }
  | { readonly ended: 'terminated'; readonly exit: ChildExit }
  | { readonly ended: 'killed'; readonly exit: ChildExit | undefined }
  | { readonly ended: 'never-started' };

const untilAborted = (signal: AbortSignal): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal.aborted) {
    resolve();
  } else {
    signal.addEventListener('abort', () => resolve(), { once: true });
  }
  return promise;
};

/** Run the process until it exits or `signal` aborts; then SIGTERM, and SIGKILL if that is ignored. */
async function supervise(
  spawn: Spawn,
  clock: Clock,
  args: readonly string[],
  options: TartCallOptions,
  onText: (text: string) => void,
  signal: AbortSignal,
): Promise<Supervised> {
  if (signal.aborted) {
    return { ended: 'never-started' };
  }
  const child = spawn('tart', args, {
    ...(options.stdin === undefined ? {} : { input: options.stdin }),
    stderr: textSink(onText),
    stdout: textSink(onText),
  });
  const natural = await Promise.race([child.exited, untilAborted(signal)]);
  if (natural !== undefined) {
    return { ended: 'exited', exit: natural };
  }
  child.kill('SIGTERM');
  const afterTerm = await resolvesWithin(clock, child.exited, TART_TERM_GRACE_MS);
  if (afterTerm !== undefined) {
    return { ended: 'terminated', exit: afterTerm };
  }
  child.kill('SIGKILL');
  return { ended: 'killed', exit: await resolvesWithin(clock, child.exited, TART_KILL_WAIT_MS) };
}

const codeOf = (exit: ChildExit | undefined, fallback: number): number =>
  exit?.kind === 'exited' ? exit.code : fallback;

/** Turn how the process ended into the outcome, given why it was cut short (if it was). */
function outcomeOf(supervised: Supervised, cause: EndCause, output: string): TartOutcome {
  if (supervised.ended === 'never-started') {
    return cause === 'deadline'
      ? { cause, exitCode: ABORTED_EXIT_CODE, kind: 'timed-out', output }
      : { cause, exitCode: ABORTED_EXIT_CODE, kind: 'aborted', output };
  }
  if (supervised.ended === 'killed') {
    return { cause, exitCode: codeOf(supervised.exit, KILLED_EXIT_CODE), kind: 'killed', output };
  }
  const { exit } = supervised;
  if (exit.kind === 'unstarted') {
    return { error: exit.error, kind: 'unstarted' };
  }
  if (supervised.ended === 'exited') {
    return { exitCode: exit.code, kind: 'completed', output };
  }
  return cause === 'deadline'
    ? { cause, exitCode: exit.code, kind: 'timed-out', output }
    : { cause, exitCode: exit.code, kind: 'aborted', output };
}

/**
 * Start `tart <args>`. The outcome never rejects. Its exit code is the process's own when it
 * exited, and 143 or 137 (the shell's codes for SIGTERM and SIGKILL) when it was cut short.
 */
export function startTart(
  spawn: Spawn,
  clock: Clock,
  args: readonly string[],
  options: TartCallOptions,
): TartCall {
  const terminator = new AbortController();
  const signal =
    options.signal === undefined
      ? terminator.signal
      : AbortSignal.any([options.signal, terminator.signal]);
  let tail = '';
  const keep = (text: string): void => {
    tail = (tail + text).slice(-OUTPUT_TAIL_CHARS);
    options.onOutput?.(text);
  };
  const watch = async (): Promise<TartOutcome> => {
    const watched = await withDeadline(
      clock,
      Math.min(options.deadlineMs ?? MAX_TIMER_MS, MAX_TIMER_MS),
      (callSignal) => supervise(spawn, clock, args, options, keep, callSignal),
      { parent: signal, waitForWork: true },
    );
    if (!watched.ok) {
      return { error: new Error(watched.why), kind: 'unstarted' };
    }
    return outcomeOf(watched.value, watched.timedOut ? 'deadline' : 'abort', tail);
  };
  return { outcome: watch(), terminate: () => terminator.abort() };
}

/** Run `tart <args>` to its end, within `options.deadlineMs`. */
export function runTart(
  spawn: Spawn,
  clock: Clock,
  args: readonly string[],
  options: TartCallOptions,
): Promise<TartOutcome> {
  return startTart(spawn, clock, args, options).outcome;
}
