/* oxlint-disable node/no-sync, promise/avoid-new, promise/prefer-await-to-then, typescript/parameter-properties -- test support: simple fixtures and a hand-rolled fake */
/** Test doubles for the tart port and the clock: a scripted guest and a virtual timeline. */
import type { Child, ChildExit, Host } from '@loomcli/core';

import { GUEST_TOOL_FILES, stepFiles } from './guest-paths';
import { KILL_GROUP_MARKER, READ_FILE_MARKER } from './housekeeping';
import { TartCallError } from './tart';
import type {
  CallOptions,
  Clock,
  ExecOptions,
  ExecResult,
  ReadOnlyShare,
  Tart,
  VmProcess,
} from './tart';
import { TART_DELETE_DEADLINE_MS, TART_SET_DEADLINE_MS } from './tart-process';

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

/**
 * Guest housekeeping commands that never answer, until their signal aborts them. A wedged `set` or
 * `delete` fails at its deadline without the SIGTERM/SIGKILL escalation of the real helper; tests of
 * escalation time use `createTartCli(new FakeSpawn(...))` instead.
 */
export type Wedged = {
  kill?: boolean;
  logCopy?: boolean;
  statusPoll?: boolean;
  stop?: boolean;
  /** `tart set` never answers; the call fails once its deadline passes, as the real helper does. */
  set?: boolean;
  /** `tart delete` never answers, for this many calls (`Infinity` for all); each fails at its deadline. */
  delete?: number;
};

/** What the guest's `mise` prints for the runner's tool steps (ADR-0006). */
export type FakeMise = {
  /** `mise env --json` of the workflow tools; the default is a `PATH` of `/fake/tools:/usr/bin`. */
  readonly toolEnvironment?: string;
  readonly toolEnvironmentExitCode?: number;
  /** The listing of the config files in the workspace: JSON lines: `{kind: "workspace", real}` and `{kind: "file", real, path}`. */
  readonly configListing?: string;
  /** `mise ls --current --json`. */
  readonly configRequests?: string;
  /** `mise env --json` of the config, written by the install script. */
  readonly configEnvironment?: string;
  readonly workflowBins?: string;
  /** Exit codes of the mise-config step's scripts. */
  readonly exitCodes?: Partial<Record<'listing' | 'requests' | 'install', number>>;
};

export type FakeGuest = {
  mise?: FakeMise;
  checkoutExitCode?: number;
  /** The checkout never finishes, like a stalled clone. */
  checkoutHangs?: boolean;
  /** The exit code of the checkout step's workspace script. */
  materializeExitCode?: number;
  /** Probe failures before the guest agent answers; `Infinity` means never. */
  probeFailures?: number;
  vmExitsOnBoot?: number;
  steps: Record<number, StepBehavior>;
  /** Local VMs that exist before the test starts; clones and deletes change the set. */
  vms?: string[];
  /** `list` throws with this message. */
  listError?: string;
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
  private deleteCalls = 0;
  private readonly vms: Set<string>;

  constructor(
    private readonly clock: FakeClock,
    readonly guest: FakeGuest = { steps: {} },
  ) {
    this.deleteFailures = guest.deleteErrors ?? 0;
    this.vms = new Set(guest.vms);
  }

  async clone(image: string, vm: string, _options?: CallOptions): Promise<void> {
    this.events.push(`clone ${image} ${vm}`);
    if (this.guest.cloneError) {
      throw new Error(this.guest.cloneError);
    }
    this.vms.add(vm);
  }

  async list(): Promise<string[]> {
    this.events.push('list');
    if (this.guest.listError) {
      throw new Error(this.guest.listError);
    }
    return [...this.vms];
  }

  async setResources(
    vm: string,
    resources: { cpus: number; memoryMb: number },
    _options?: CallOptions,
  ): Promise<void> {
    this.events.push(`set ${vm} ${resources.cpus} ${resources.memoryMb}`);
    if (this.guest.wedged?.set) {
      await this.clock.sleep(TART_SET_DEADLINE_MS);
      throw new TartCallError('timed-out', 'tart set', vm, `tart set ${vm} timed out`);
    }
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
    if (stdin.startsWith('# hugi-tool-env')) {
      return this.toolEnvironment(options);
    }
    const phase = /^# hugi-mise-config (\w+)/.exec(stdin)?.[1];
    if (phase !== undefined) {
      return this.miseConfig(phase, options);
    }
    const index = Number(/^# hugi-step (\d+)/.exec(stdin)?.[1]);
    return this.launch(index);
  }

  private toolEnvironment(options: ExecOptions): ExecResult {
    const mise = this.guest.mise ?? {};
    this.events.push('tool environment');
    this.files.set(
      GUEST_TOOL_FILES.environment,
      mise.toolEnvironment ?? '{"PATH":"/fake/tools:/usr/bin"}',
    );
    options.onOutput?.('mise env\n');
    return { exitCode: mise.toolEnvironmentExitCode ?? 0 };
  }

  /** The three scripts of the mise-config step: `listing`, `requests`, and `install`. */
  private miseConfig(phase: string, options: ExecOptions): ExecResult {
    const mise = this.guest.mise ?? {};
    this.events.push(`mise config ${phase}`);
    options.onOutput?.(`mise config ${phase}\n`);
    if (phase === 'listing') {
      this.files.set(GUEST_TOOL_FILES.configListing, mise.configListing ?? '');
    } else if (phase === 'requests') {
      this.files.set(GUEST_TOOL_FILES.configRequests, mise.configRequests ?? '{}');
    } else {
      this.files.set(
        GUEST_TOOL_FILES.configEnvironment,
        mise.configEnvironment ?? '{"PATH":"/fake/config:/usr/bin"}',
      );
      this.files.set(GUEST_TOOL_FILES.workflowBins, mise.workflowBins ?? '');
    }
    const codes: Record<string, number | undefined> = { ...mise.exitCodes };
    return { exitCode: codes[phase] ?? 0 };
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

  async delete(vm: string, options: { deadlineMs?: number } = {}): Promise<void> {
    this.events.push(`delete ${vm}`);
    this.deleteCalls += 1;
    if (this.deleteCalls <= (this.guest.wedged?.delete ?? 0)) {
      await this.clock.sleep(
        Math.min(TART_DELETE_DEADLINE_MS, options.deadlineMs ?? TART_DELETE_DEADLINE_MS),
      );
      throw new TartCallError('timed-out', 'tart delete', vm, `tart delete ${vm} timed out`);
    }
    if (this.vmRunning) {
      throw new Error(`${vm} is still running`);
    }
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1;
      throw new Error('vm is busy');
    }
    this.vms.delete(vm);
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

/** What one scripted `tart` process does. */
export type FakeCommand = {
  readonly exitCode?: number;
  readonly output?: string;
  /** Answers only after this many virtual milliseconds; a signal still ends it sooner. */
  readonly takesMs?: number;
  /** Runs until a signal ends it, like a wedged tart. */
  readonly hangs?: boolean;
  /** With `hangs`: SIGTERM does nothing, as with a process stuck in the kernel or a guest agent call. */
  readonly ignoresSigterm?: boolean;
  /** With `hangs`: not even SIGKILL ends it within the test. */
  readonly unkillable?: boolean;
};

export type SpawnedCommand = {
  readonly command: string;
  readonly args: readonly string[];
  /** The signals sent to the process, in order. */
  readonly signals: string[];
  /** Virtual time of the spawn and of the process's exit (undefined while it runs). */
  readonly startedAt: number;
  endedAt?: number;
};

/** A fake `host.spawn`: each command behaves as `script` says, on the fake clock. */
export class FakeSpawn {
  readonly calls: SpawnedCommand[] = [];

  constructor(
    private readonly clock: FakeClock,
    private readonly script: (args: readonly string[]) => FakeCommand = () => ({}),
  ) {}

  readonly spawn: Host['spawn'] = (command, args, options) => {
    const behavior = this.script(args);
    const call: SpawnedCommand = {
      args,
      command,
      signals: [],
      startedAt: this.clock.now(),
    };
    this.calls.push(call);
    const writable = options && 'stdout' in options ? options.stdout : undefined;
    const sink = typeof writable === 'object' ? writable : undefined;
    const { promise: exited, resolve: finish } = Promise.withResolvers<ChildExit>();
    const slow = behavior.hangs || behavior.takesMs !== undefined;
    const end = (code: number): void => {
      if (call.endedAt !== undefined) {
        return;
      }
      if (behavior.output) {
        sink?.write(behavior.output);
      }
      call.endedAt = this.clock.now();
      finish(exitOf(code, behavior.output ?? ''));
    };
    if (behavior.takesMs !== undefined && !behavior.hangs) {
      void this.clock.sleep(behavior.takesMs).then(() => end(behavior.exitCode ?? 0));
    } else if (!behavior.hangs) {
      void Promise.resolve().then(() => end(behavior.exitCode ?? 0));
    }
    const child: Child = {
      // As Loom's contract says: settle at once, with no output yet, unless the exit came first.
      abandon: () => {
        if (call.endedAt === undefined) {
          call.endedAt = this.clock.now();
          finish({ kind: 'abandoned', stderr: noOutput, stdout: noOutput });
        }
      },
      exited,
      kill: (signal = 'SIGTERM') => {
        call.signals.push(signal);
        if (!slow || call.endedAt !== undefined) {
          return;
        }
        if (signal === 'SIGKILL' && !behavior.unkillable) {
          end(137);
        } else if (signal === 'SIGTERM' && !behavior.ignoresSigterm) {
          end(143);
        }
      },
    };
    return child;
  };
}

const noOutput = { bytes: new Uint8Array(), text: '' };

const exitOf = (code: number, text: string): ChildExit => ({
  code,
  kind: 'exited',
  stderr: { bytes: new Uint8Array(), text: '' },
  stdout: { bytes: new TextEncoder().encode(text), text },
});
