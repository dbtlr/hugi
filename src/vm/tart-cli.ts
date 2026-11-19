/**
 * The real `Tart` port: drives the `tart` command-line tool through the run's `host.spawn`. Every
 * call goes through `runTart`/`startTart` (`tart-process.ts`), so each has a deadline and SIGKILL
 * escalation; a call that overruns throws a `TartCallError`.
 */
import type { Host } from '@loomcli/core';

import { systemClock } from './clock';
import { TartCallError } from './tart';
import type { Clock, ExecOptions, ExecResult, Tart, VmProcess } from './tart';
import {
  runTart,
  startTart,
  TART_CLONE_DEADLINE_MS,
  TART_DELETE_DEADLINE_MS,
  TART_EXEC_DEADLINE_MS,
  TART_SET_DEADLINE_MS,
  TART_STOP_DEADLINE_MS,
} from './tart-process';
import type { TartOutcome } from './tart-process';

type Spawn = Host['spawn'];

const OUTPUT_TAIL_BYTES = 8192;
const UNSTARTED_EXIT_CODE = 127;

/**
 * How long `tart stop` lets the guest shut down before it forces the VM off.
 * The VM is deleted next, so a graceful shutdown buys nothing; this keeps the
 * stop well inside its deadline (`TART_STOP_DEADLINE_MS`).
 */
const STOP_GRACE_SECONDS = 10;

type CommandOptions = {
  /** The VM the command is about, named in the error of a call that overruns. */
  readonly vm?: string;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
};

type Overrun = Extract<TartOutcome, { kind: 'timed-out' | 'killed' | 'aborted' }>;

/** The error for a call that ended without finishing: names the command and the VM. */
function overrun(command: string, vm: string | undefined, outcome: Overrun): Error {
  const cause = outcome.cause === 'deadline' ? 'ran past its deadline' : 'was aborted';
  const ending =
    outcome.kind === 'killed' ? `${cause} and ignored SIGTERM, so it was killed` : cause;
  const output = outcome.output.trim();
  const detail = `${command} ${ending}${output === '' ? '' : `: ${output}`}`;
  if (outcome.kind === 'aborted') {
    return new Error(detail);
  }
  return new TartCallError(outcome.kind === 'killed' ? 'killed' : 'timed-out', command, vm, detail);
}

/** Run `tart <args>` to completion; a failure to start, a non-zero exit, or an overrun throws. */
async function tartCommand(
  spawn: Spawn,
  clock: Clock,
  args: readonly string[],
  options: CommandOptions,
): Promise<void> {
  const command = `tart ${args.join(' ')}`;
  const outcome = await runTart(spawn, clock, args, {
    deadlineMs: options.deadlineMs,
    signal: options.signal,
  });
  if (outcome.kind === 'completed') {
    if (outcome.exitCode !== 0) {
      throw new Error(`${command} exited ${outcome.exitCode}: ${outcome.output.trim()}`);
    }
    return;
  }
  throw outcome.kind === 'unstarted' ? outcome.error : overrun(command, options.vm, outcome);
}

/** The shorter of a call's own deadline and the one its caller asks for. */
const tighter = (own: number, requested: number | undefined): number =>
  requested === undefined ? own : Math.min(own, requested);

async function execInVm(
  spawn: Spawn,
  clock: Clock,
  vm: string,
  argv: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const args = ['exec', ...(options.stdin === undefined ? [] : ['-i']), vm, ...argv];
  const outcome = await runTart(spawn, clock, args, {
    deadlineMs: TART_EXEC_DEADLINE_MS,
    onOutput: options.onOutput,
    signal: options.signal,
    stdin: options.stdin,
  });
  if (outcome.kind === 'unstarted') {
    throw outcome.error;
  }
  // An exec the caller aborted reports the signal's exit code, as the caller expects.
  if (outcome.kind === 'completed' || outcome.cause === 'abort') {
    return { exitCode: outcome.exitCode };
  }
  throw overrun(`tart exec ${vm}`, vm, outcome);
}

function runVm(
  spawn: Spawn,
  clock: Clock,
  vm: string,
  options: { readonly readOnlyShares: readonly { name: string; hostPath: string }[] },
): VmProcess {
  const shares = options.readOnlyShares.map((share) => `--dir=${share.name}:${share.hostPath}:ro`);
  let tail = '';
  const keep = (text: string): void => {
    tail = (tail + text).slice(-OUTPUT_TAIL_BYTES);
  };
  const call = startTart(spawn, clock, ['run', '--no-graphics', ...shares, vm], {
    onOutput: keep,
  });
  const waitForExit = async (): Promise<number> => {
    const outcome = await call.outcome;
    if (outcome.kind === 'unstarted') {
      keep(outcome.error.message);
      return UNSTARTED_EXIT_CODE;
    }
    return outcome.exitCode;
  };
  return { exited: waitForExit(), kill: call.terminate, output: () => tail };
}

/** A `Tart` that runs the real tool with the given spawn (the run's `host.spawn`). */
export function createTartCli(spawn: Spawn, clock: Clock = systemClock): Tart {
  return {
    clone: (image, vm, options) =>
      tartCommand(spawn, clock, ['clone', image, vm], {
        deadlineMs: TART_CLONE_DEADLINE_MS,
        signal: options?.signal,
        vm,
      }),
    delete: (vm, options) =>
      tartCommand(spawn, clock, ['delete', vm], {
        deadlineMs: tighter(TART_DELETE_DEADLINE_MS, options?.deadlineMs),
        vm,
      }),
    exec: (vm, argv, options) => execInVm(spawn, clock, vm, argv, options),
    run: (vm, options) => runVm(spawn, clock, vm, options),
    setResources: (vm, resources, options) =>
      tartCommand(
        spawn,
        clock,
        ['set', vm, '--cpu', String(resources.cpus), '--memory', String(resources.memoryMb)],
        { deadlineMs: TART_SET_DEADLINE_MS, signal: options?.signal, vm },
      ),
    stop: (vm, options) =>
      tartCommand(spawn, clock, ['stop', '--timeout', String(STOP_GRACE_SECONDS), vm], {
        deadlineMs: TART_STOP_DEADLINE_MS,
        signal: options?.signal,
        vm,
      }),
  };
}
