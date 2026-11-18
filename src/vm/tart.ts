/**
 * The port through which the runner drives tart. The real implementation
 * (`tart-cli.ts`) shells out; tests substitute a fake. Operations that fail
 * throw an Error whose message carries tart's own output.
 */

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
  /** Kill the `tart run` process, which ends the VM: the last resort when `tart stop` does not. */
  readonly kill: () => void;
};

export type Tart = {
  readonly clone: (image: string, vm: string) => Promise<void>;
  readonly setResources: (
    vm: string,
    resources: { readonly cpus: number; readonly memoryMb: number },
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
  /** Aborting `signal` kills the `tart stop` process, which then throws. */
  readonly stop: (vm: string, options?: { readonly signal?: AbortSignal }) => Promise<void>;
  readonly delete: (vm: string) => Promise<void>;
};

/** Time, injected so tests control it. `sleep` resolves true when the time elapsed, false when `signal` cancelled it. */
export type Clock = {
  readonly now: () => number;
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<boolean>;
};
