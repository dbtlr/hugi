/**
 * A step the runner drives from the host as a series of guest scripts, instead of launching one
 * detached script: the checkout, the tool environment, and the install from the repository's mise
 * config. The step is bounded by the job deadline, ends early when the VM is lost or Hugi is
 * interrupted, and writes its output to a log file of its own.
 */
import { withDeadline } from './deadline';
import { readGuestFile } from './housekeeping';
import { openLogFile, stepLogName } from './logs';
import type { LogFile } from './logs';
import type { StepResult } from './run-request';
import type { Clock, Tart } from './tart';

/** What a host-driven step needs of the run. */
export type HostStepContext = {
  readonly tart: Tart;
  readonly clock: Clock;
  readonly vm: string;
  readonly logDir: string;
  readonly interrupt: AbortSignal;
  /** Aborts when the VM process exits after boot. */
  readonly vmLost: AbortSignal;
  /** The deadline of one housekeeping call, such as reading a result file. */
  readonly housekeepingMs: number;
};

/** What ended a host-driven step, if anything other than its own verdict. */
export type HostStepEnd = 'exited' | 'job-timeout' | 'interrupted' | 'vm-lost' | 'infrastructure';

/** What a step's body decided: its verdict on its own work, and a value for the caller. */
export type HostStepVerdict<Value> = {
  readonly ok: boolean;
  readonly note?: string;
  readonly error?: string;
  readonly exitCode?: number;
  readonly value?: Value;
};

/** What a body can do: run a guest script (its output goes to the log), read a guest file, and write notes. */
export type HostStepTools = {
  readonly exec: (script: string) => Promise<number>;
  readonly readFile: (path: string) => Promise<string>;
  readonly log: LogFile;
};

export type HostStepRun<Value> = {
  readonly result: StepResult;
  readonly end: HostStepEnd;
  readonly value?: Value;
};

/**
 * Run `body`, which returns its verdict. A body that throws, as when the guest agent stops
 * answering, makes the step an `infrastructure` end; so does a verdict of `ok: false` when
 * `failureIsInfrastructure` says the failure lies outside the lane.
 */
export async function runHostStep<Value>(
  ctx: HostStepContext,
  step: { readonly index: number; readonly name: string },
  remainingMs: number,
  body: (tools: HostStepTools) => Promise<HostStepVerdict<Value>>,
  failureIsInfrastructure = false,
): Promise<HostStepRun<Value>> {
  const log = await openLogFile(ctx.logDir, stepLogName(step.index, step.name));
  const began = ctx.clock.now();
  try {
    const finished = await withDeadline(
      ctx.clock,
      remainingMs,
      (signal) =>
        body({
          exec: async (script) => {
            const { exitCode } = await ctx.tart.exec(ctx.vm, ['bash', '-s'], {
              onOutput: (chunk) => log.write(chunk),
              signal,
              stdin: script,
            });
            return exitCode;
          },
          log,
          readFile: async (path) => {
            const read = await readGuestFile(
              {
                clock: ctx.clock,
                deadlineMs: ctx.housekeepingMs,
                tart: ctx.tart,
                vm: ctx.vm,
              },
              path,
              signal,
            );
            if (!read.ok) {
              throw new Error(`could not read ${path} (${read.why})`);
            }
            return read.value;
          },
        }),
      { parent: AbortSignal.any([ctx.interrupt, ctx.vmLost]), waitForWork: true },
    );
    const base = {
      index: step.index,
      logFile: log.path,
      name: step.name,
      seconds: (ctx.clock.now() - began) / 1000,
    };
    const failed = (end: Exclude<HostStepEnd, 'exited'>, error: string): HostStepRun<Value> => ({
      end,
      result: { ...base, error, outcome: 'failure' },
    });
    if (ctx.vmLost.aborted) {
      return failed('vm-lost', `the VM exited during ${step.name}`);
    }
    if (ctx.interrupt.aborted) {
      return failed('interrupted', `interrupted during ${step.name}`);
    }
    if (finished.timedOut) {
      return { end: 'job-timeout', result: { ...base, outcome: 'timeout' } };
    }
    if (!finished.ok) {
      return failed('infrastructure', `${step.name} failed: ${finished.why}`);
    }
    const verdict = finished.value;
    if (!verdict.ok) {
      const error = verdict.error ?? `${step.name} failed`;
      log.write(`Error: ${error}\n`);
      return {
        end: failureIsInfrastructure ? 'infrastructure' : 'exited',
        result: {
          ...base,
          error,
          outcome: 'failure',
          ...(verdict.exitCode === undefined ? {} : { exitCode: verdict.exitCode }),
        },
      };
    }
    return {
      end: 'exited',
      result: {
        ...base,
        outcome: 'success',
        ...(verdict.exitCode === undefined ? {} : { exitCode: verdict.exitCode }),
        ...(verdict.note === undefined ? {} : { note: verdict.note }),
      },
      ...(verdict.value === undefined ? {} : { value: verdict.value }),
    };
  } finally {
    await log.close();
  }
}
