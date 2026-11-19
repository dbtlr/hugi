/**
 * The port through which the runner drives tart. The real implementation
 * (`tart-cli.ts`) shells out; tests substitute a fake. Operations that fail
 * throw an Error whose message carries tart's own output. Every real call has a
 * deadline (`tart-process.ts`), except `run`, which lasts until the VM stops or is killed. A call
 * that runs past its deadline, or ignores SIGTERM and is killed, throws a `TartCallError`; a call
 * the caller aborted throws a plain Error, and an aborted `exec` returns its exit code.
 */

/** Why a tart call that never completed ended: its deadline, or SIGKILL after it ignored SIGTERM. */
export type TartCallFailure = 'timed-out' | 'killed';

/**
 * A tart call that did not finish: it ran past its deadline, or it ignored SIGTERM and was killed.
 * `vm` names the VM it was about, for an operator's cleanup. */
export class TartCallError extends Error {
  readonly failure: TartCallFailure;
  readonly command: string;
  readonly vm: string | undefined;

  constructor(failure: TartCallFailure, command: string, vm: string | undefined, detail: string) {
    super(detail);
    this.name = 'TartCallError';
    this.failure = failure;
    this.command = command;
    this.vm = vm;
  }
}

/** What a caller can do to a tart call in flight. */
export type CallOptions = { readonly signal?: AbortSignal };

export type ReadOnlyShare = {
  /** The directory name under `/Volumes/My Shared Files` in the guest. */
  readonly name: string;
  readonly hostPath: string;
};

export type ExecOptions = {
  /** Text fed to the command's standard input. */
  readonly stdin?: string;
  /** Receives the command's combined stdout and stderr as it arrives. */
  readonly onOutput?: (chunk: string) => void;
  /** Aborting kills the host-side process; the result then carries a non-zero exit code. */
  readonly signal?: AbortSignal;
};

export type ExecResult = { readonly exitCode: number };

/** A VM started with `tart run`. */
export type VmProcess = {
  /** Resolves with the exit code when the VM stops, however it stopped. */
  readonly exited: Promise<number>;
  /** What the VM process has printed so far, for diagnosing a failed boot. */
  readonly output: () => string;
  /**
   * End the `tart run` process, and with it the VM: the last resort when `tart stop` does not.
   * It sends SIGTERM, then SIGKILL after a grace period if the process is still there.
   */
  readonly kill: () => void;
};

export type Tart = {
  /** Aborting `signal` ends the `tart clone` process, which then throws; the VM may or may not exist. */
  readonly clone: (image: string, vm: string, options?: CallOptions) => Promise<void>;
  readonly setResources: (
    vm: string,
    resources: { readonly cpus: number; readonly memoryMb: number },
    options?: CallOptions,
  ) => Promise<void>;
  readonly run: (
    vm: string,
    options: { readonly readOnlyShares: readonly ReadOnlyShare[] },
  ) => VmProcess;
  readonly exec: (
    vm: string,
    argv: readonly string[],
    options?: ExecOptions,
  ) => Promise<ExecResult>;
  /** Aborting `signal` ends the `tart stop` process, which then throws. */
  readonly stop: (vm: string, options?: { readonly signal?: AbortSignal }) => Promise<void>;
  /** Throws a `TartCallError` naming the VM when the delete outlives its deadline (`deadlineMs` can only shorten it). */
  readonly delete: (vm: string, options?: { readonly deadlineMs?: number }) => Promise<void>;
};

/** Time, injected so tests control it. `sleep` resolves true when the time elapsed, false when `signal` cancelled it. */
export type Clock = {
  readonly now: () => number;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<boolean>;
};
