/* oxlint-disable node/no-sync, promise/avoid-new, promise/prefer-await-to-then, typescript/parameter-properties -- test support: simple fixtures and a hand-rolled fake */
/** Test doubles for the tart port and the clock: a scripted guest and a virtual timeline. */
import { stepFiles } from './guest-paths';
import { KILL_GROUP_MARKER, READ_FILE_MARKER } from './housekeeping';
import type { Clock, ExecOptions, ExecResult, ReadOnlyShare, Tart, VmProcess } from './tart';

/** A clock whose time only moves when a test advances it. */
export class FakeClock implements Clock {
  private time = 0;
  private timers: { at: number; wake: (elapsed: boolean) => void }[] = [];

  now(): number {
    return this.time;
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        return resolve(false);
      }
      const timer = { at: this.time + milliseconds, wake: resolve };
      this.timers.push(timer);
      signal?.addEventListener(
        'abort',
        () => {
          this.timers = this.timers.filter((candidate) => candidate !== timer);
          resolve(false);
        },
        { once: true },
      );
    });
  }

  advance(milliseconds: number): void {
    this.time += milliseconds;
    const due = this.timers.filter((timer) => timer.at <= this.time);
    this.timers = this.timers.filter((timer) => timer.at > this.time);
    for (const timer of due) {
      timer.wake(true);
    }
  }
}

/** Let pending promise callbacks run. */
export const settle = async (): Promise<void> => {
  for (let round = 0; round < 5; round += 1) {
    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/** Drive the fake clock forward until `work` settles, one `stepMs` at a time. */
export async function advanceUntilSettled<T>(
  clock: FakeClock,
  work: Promise<T>,
  stepMs = 1000,
): Promise<T> {
  const progress = { done: false };
  const markDone = async (): Promise<void> => {
    try {
      await work;
    } finally {
      progress.done = true;
    }
  };
  void markDone().catch(() => undefined);
  for (let rounds = 0; rounds < 100_000; rounds += 1) {
    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    await settle();
    if (progress.done) {
      break;
    }
    clock.advance(stepMs);
  }
  return work;
}

/** What a scripted step does in the guest. */
export type StepBehavior = {
  readonly exitCode?: number;
  readonly output?: string;
  /** Text the step appends to its `GITHUB_ENV` / `GITHUB_PATH` file. */
  readonly appendsEnv?: string;
  readonly appendsPath?: string;
  /** Text the step appends to its `GITHUB_OUTPUT` file. */
  readonly appendsOutput?: string;
  /** Runs until killed, like a step that never ends. */
  readonly hangs?: boolean;
  /** Virtual milliseconds the step takes. */
  readonly takesMs?: number;
  /** Starting the step throws, as when tart itself fails. */
  readonly throws?: string;
  /** The VM process exits once the step has started. */
  readonly vmExits?: boolean;
  /** The guest agent stops answering once the step has started. */
  readonly agentLost?: boolean;
};

/** Guest housekeeping commands that never answer, until their signal aborts them. */
export type Wedged = { kill?: boolean; logCopy?: boolean; statusPoll?: boolean; stop?: boolean };

export type FakeGuest = {
  checkoutExitCode?: number;
  /** The checkout never finishes, like a stalled clone. */
  checkoutHangs?: boolean;
  /** The exit code of the checkout step's workspace script. */
  materializeExitCode?: number;
  /** Probe failures before the guest agent answers; `Infinity` means never. */
  probeFailures?: number;
  vmExitsOnBoot?: number;
  steps: Record<number, StepBehavior>;
  cloneError?: string;
  deleteErrors?: number;
  wedged?: Wedged;
};

export type ExecCall = { readonly argv: readonly string[]; readonly stdin?: string };

/** Resolve when `signal` aborts; never otherwise. */
const untilAborted = (signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      return resolve();
    }
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });

const ABORTED_EXIT_CODE = 143;
const AGENT_LOST_EXIT_CODE = 1;

export class FakeTart implements Tart {
  readonly events: string[] = [];
  readonly execs: ExecCall[] = [];
  readonly shares: (readonly ReadOnlyShare[])[] = [];
  /** The guest's files that the runner reads, by path. */
  readonly files = new Map<string, string>();
  private exitVm: (code: number) => void = () => undefined;
  private vmRunning = false;
  private agentLost = false;
  private readonly killed = new Set<string>();
  private deleteFailures: number;

  constructor(
    private readonly clock: FakeClock,
    readonly guest: FakeGuest = { steps: {} },
  ) {
    this.deleteFailures = guest.deleteErrors ?? 0;
  }

  async clone(image: string, vm: string): Promise<void> {
    this.events.push(`clone ${image} ${vm}`);
    if (this.guest.cloneError) {
      throw new Error(this.guest.cloneError);
    }
  }

  async setResources(vm: string, resources: { cpus: number; memoryMb: number }): Promise<void> {
    this.events.push(`set ${vm} ${resources.cpus} ${resources.memoryMb}`);
  }

  run(vm: string, options: { readOnlyShares: readonly ReadOnlyShare[] }): VmProcess {
    this.events.push(`run ${vm}`);
    this.shares.push(options.readOnlyShares);
    this.vmRunning = true;
    const exited = new Promise<number>((resolve) => {
      this.exitVm = (code) => {
        this.vmRunning = false;
        resolve(code);
      };
    });
    if (this.guest.vmExitsOnBoot !== undefined) {
      this.exitVm(this.guest.vmExitsOnBoot);
    }
    return {
      exited,
      kill: () => {
        this.events.push(`kill ${vm}`);
        this.exitVm(137);
      },
      output: () => 'boot failed: no capacity',
    };
  }

  async exec(vm: string, argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    this.execs.push({ argv, stdin: options.stdin });
    if (!this.vmRunning || this.agentLost) {
      return { exitCode: AGENT_LOST_EXIT_CODE };
    }
    if (argv[0] === 'true') {
      return this.probe();
    }
    if (argv[3] === READ_FILE_MARKER) {
      return this.read(argv[4]!, options);
    }
    if (argv[3] === KILL_GROUP_MARKER) {
      return this.kill(argv[4]!, options);
    }
    const stdin = options.stdin ?? '';
    if (stdin.startsWith('# hugi-checkout')) {
      return this.checkout(options);
    }
    if (stdin.startsWith('# hugi-workspace')) {
      this.events.push('materialize');
      options.onOutput?.('checked out abc123\n');
      return { exitCode: this.guest.materializeExitCode ?? 0 };
    }
    const index = Number(/^# hugi-step (\d+)/.exec(stdin)?.[1]);
    return this.launch(index);
  }

  private probe(): ExecResult {
    const failures = this.guest.probeFailures ?? 0;
    if (failures > 0) {
      this.guest.probeFailures = failures - 1;
      return { exitCode: 1 };
    }
    return { exitCode: 0 };
  }

  private async checkout(options: ExecOptions): Promise<ExecResult> {
    this.events.push('checkout');
    options.onOutput?.('cloning\n');
    if (this.guest.checkoutHangs) {
      await untilAborted(options.signal);
      return { exitCode: ABORTED_EXIT_CODE };
    }
    return { exitCode: this.guest.checkoutExitCode ?? 0 };
  }

  private async read(path: string, options: ExecOptions): Promise<ExecResult> {
    const wedged = this.guest.wedged ?? {};
    if (
      (wedged.logCopy && path.endsWith('.log')) ||
      (wedged.statusPoll && path.endsWith('/status'))
    ) {
      await untilAborted(options.signal);
      return { exitCode: ABORTED_EXIT_CODE };
    }
    options.onOutput?.(this.files.get(path) ?? '');
    return { exitCode: 0 };
  }

  private async kill(processGroupFile: string, options: ExecOptions): Promise<ExecResult> {
    this.events.push('kill step');
    if (this.guest.wedged?.kill) {
      await untilAborted(options.signal);
      return { exitCode: ABORTED_EXIT_CODE };
    }
    this.killed.add(processGroupFile);
    return { exitCode: 0 };
  }

  /** Start step `index` detached, as the real launcher does, and return at once. */
  private launch(index: number): ExecResult {
    const behavior = this.guest.steps[index] ?? {};
    this.events.push(`step ${index}`);
    if (behavior.throws) {
      throw new Error(behavior.throws);
    }
    void this.simulate(index, behavior);
    if (behavior.vmExits) {
      this.exitVm(1);
    }
    if (behavior.agentLost) {
      this.agentLost = true;
    }
    return { exitCode: 0 };
  }

  /** What the step's process does in the guest: write its files, then its status unless killed. */
  private async simulate(index: number, behavior: StepBehavior): Promise<void> {
    const files = stepFiles(index);
    this.files.set(files.log, behavior.output ?? '');
    this.files.set(files.env, behavior.appendsEnv ?? '');
    this.files.set(files.path, behavior.appendsPath ?? '');
    this.files.set(files.output, behavior.appendsOutput ?? '');
    this.files.set(files.processGroup, `${1000 + index}\n`);
    if (behavior.hangs) {
      return;
    }
    if (behavior.takesMs) {
      await this.clock.sleep(behavior.takesMs);
    }
    if (!this.killed.has(files.processGroup)) {
      this.files.set(files.status, `${behavior.exitCode ?? 0}\n`);
    }
  }

  async stop(vm: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    this.events.push(`stop ${vm}`);
    if (this.guest.wedged?.stop) {
      await untilAborted(options.signal);
      throw new Error('tart stop was killed');
    }
    this.exitVm(0);
  }

  async delete(vm: string): Promise<void> {
    this.events.push(`delete ${vm}`);
    if (this.vmRunning) {
      throw new Error(`${vm} is still running`);
    }
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1;
      throw new Error('vm is busy');
    }
  }

  /** The stdin of the launcher that ran step `index`. */
  launcherFor(index: number): string {
    const call = this.execs.find((candidate) =>
      candidate.stdin?.startsWith(`# hugi-step ${index}\n`),
    );
    if (!call?.stdin) {
      throw new Error(`step ${index} never ran`);
    }
    return call.stdin;
  }
}
