/* oxlint-disable node/no-sync, promise/avoid-new, promise/prefer-await-to-then, typescript/parameter-properties -- test support: simple fixtures and a hand-rolled fake */
/**
 * Runs plans in real tart VMs. Skipped unless HUGI_VM_TESTS=1 (Linux CI has no tart).
 * The image comes from HUGI_TEST_IMAGE. The pinned-tools case also needs
 * HUGI_GOLDEN_TESTS=1 and a local `hugi-golden` image, which it clones and never changes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { processHandle } from '@loomcli/core';
import type { Host } from '@loomcli/core';

import type { ActionStep, PlanStep, RunStep, StepPlan } from '../lane/step-plan';
import { openHostSource } from '../source/host-source';
import type { GuestSource } from '../source/host-source';
import { systemClock } from './clock';
import { runInVm, VM_NAME_PREFIX } from './lifecycle';
import type { RunRequest } from './run-request';
import { createTartCli } from './tart-cli';

const DEFAULT_IMAGE =
  'ghcr.io/cirruslabs/macos-sequoia-base@sha256:4947ac5ab1b2fdc46ab856132d2ba958f8e45b5f85192c66370dafc028c514dd';
const GOLDEN_IMAGE = 'hugi-golden';
const enabled = process.env.HUGI_VM_TESTS === '1';
const goldenEnabled = enabled && process.env.HUGI_GOLDEN_TESTS === '1';
const SLOT_WAIT_MS = 60 * 60_000;
const SLOT_POLL_MS = 60_000;
/** Each test may wait the whole slot wait, then run its VM. */
const TEST_TIMEOUT_MS = SLOT_WAIT_MS + 20 * 60_000;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

type ListedVm = { readonly name: string; readonly running: boolean };

/** `tart list` as data, read from its JSON output. */
function listVms(): ListedVm[] {
  const rows: unknown = JSON.parse(
    execFileSync('tart', ['list', '--format', 'json'], { encoding: 'utf8' }),
  );
  if (!Array.isArray(rows)) {
    throw new Error('tart list did not print a JSON array');
  }
  return rows.map((row: Record<string, unknown>) => ({
    name: String(row.Name),
    running: row.Running === true,
  }));
}

function hugiVmsRunning(): string[] {
  return listVms()
    .filter((vm) => vm.running && vm.name.startsWith('hugi-'))
    .map((vm) => vm.name);
}

/**
 * macOS allows two macOS guests at once. Each test runs one VM and has none
 * running between tests, so wait while any other Hugi VM (an image build,
 * another run) holds a slot.
 */
async function waitForFreeSlot(): Promise<void> {
  const until = Date.now() + SLOT_WAIT_MS;
  while (hugiVmsRunning().length > 0) {
    if (Date.now() > until) {
      throw new Error('gave up waiting for another hugi VM to stop');
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    await new Promise((resolve) => setTimeout(resolve, SLOT_POLL_MS));
  }
}

/** Whether the VM a test's run used still exists. */
const vmRemains = (name: string): boolean => listVms().some((vm) => vm.name === name);

const handle = processHandle();
const spawn: Host['spawn'] = (command, args, options) =>
  handle.spawn(command, args, { cwd: handle.cwd(), env: handle.env, ...options });

/** Real dependencies for one run; `vm` is the name the run's VM gets. */
function realDeps(interrupt = new AbortController().signal) {
  const id = crypto.randomUUID().slice(0, 8);
  return {
    clock: systemClock,
    interrupt,
    newId: () => id,
    tart: createTartCli(spawn),
    vm: `${VM_NAME_PREFIX}${id}`,
    warn: (message: string) => console.warn(message),
  };
}

const step = (index: number, script: string, overrides: Partial<RunStep> = {}): RunStep => ({
  continueOnError: false,
  env: {},
  index,
  kind: 'run',
  name: `step ${index}`,
  script,
  shell: 'bash',
  when: 'success',
  ...overrides,
});

/** The lane's `actions/checkout` step, which materializes the workspace. */
const checkout = (index: number): ActionStep => ({
  continueOnError: false,
  env: {},
  index,
  kind: 'action',
  name: 'actions/checkout@v4',
  uses: 'actions/checkout@v4',
  when: 'success',
  with: {},
});

const logOf = (req: RunRequest, file: string): string =>
  readFileSync(join(req.logDir, file), 'utf8');

/** An `always` step that fails when any process from the marked command survives. */
const noSurvivor = (index: number, marker: string): RunStep =>
  step(index, `if pgrep -f '${marker}'; then echo SURVIVOR; exit 1; fi\necho no survivor`, {
    when: 'always',
  });

describe.skipIf(!enabled)('runInVm in a real VM', () => {
  let scratch: string;
  let repo: string;
  let sha: string;
  let snapshot: GuestSource;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'hugi-vm-it-'));
    repo = join(scratch, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'hello.txt'), 'hello from the repo\n');
    git(repo, 'add', '.');
    const commit = (message: string): string =>
      git(
        repo,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        'commit',
        '-q',
        '-m',
        message,
      );
    commit('init');
    // History and a tag the checkout must leave behind, as actions/checkout's defaults do.
    git(repo, 'tag', 'v0.1.0');
    writeFileSync(join(repo, 'second.txt'), 'second\n');
    git(repo, 'add', '.');
    commit('second');
    sha = git(repo, 'rev-parse', 'HEAD');
    // An untracked secret the lane must not see (ADR-0002): only the snapshot is shared.
    writeFileSync(join(repo, '.env'), 'HUGI_TEST_SECRET=1\n');
    const source = await openHostSource({ kind: 'local', path: repo }, sha, {
      cacheDir: join(scratch, 'cache'),
      cwd: scratch,
      env: handle.env,
      spawn,
      tempDir: scratch,
      uid: handle.uid,
    });
    snapshot = await source.guestSource();
  });
  afterAll(async () => {
    await snapshot.release();
    rmSync(scratch, { force: true, recursive: true });
  });

  const request = (
    name: string,
    steps: PlanStep[],
    overrides: Partial<RunRequest> = {},
    timeoutMinutes = 15,
  ): RunRequest => {
    const plan: StepPlan = {
      env: { PLAN_VAR: 'from-plan' },
      lane: { job: 'test', matrix: {}, workflow: '.github/workflows/ci.yml' },
      name: 'test',
      steps,
      timeoutMinutes,
    };
    return {
      event: { event: 'push', refName: 'main', refType: 'branch', repository: 'dbtlr/hugi', sha },
      image: process.env.HUGI_TEST_IMAGE ?? DEFAULT_IMAGE,
      logDir: join(scratch, 'logs', name),
      plan,
      source: snapshot.location,
      tools: [],
      ...overrides,
    };
  };

  test(
    'a passing plan carries GITHUB_ENV between steps and leaves no VM',
    async () => {
      await waitForFreeSlot();
      const req = request('pass', [
        checkout(1),
        // Wiping RUNNER_TEMP must not take the runner's own files with it.
        step(
          2,
          'echo "HUGI_VALUE=carried" >> "$GITHUB_ENV"\ncat hello.txt\ntest -n "$RUNNER_TEMP" && rm -rf "$RUNNER_TEMP"/*',
        ),
        step(
          3,
          'test "$HUGI_VALUE" = carried && test "$PLAN_VAR" = from-plan && echo "env ok $CI $RUNNER_OS $GITHUB_REF"\ngit rev-parse HEAD\necho "commits=$(git rev-list --count HEAD) tags=[$(git tag)]"\nif grep -rqs HUGI_TEST_SECRET . "/Volumes/My Shared Files"; then echo "secret visible"; else echo "no secret"; fi',
        ),
      ]);
      const deps = realDeps();
      const result = await runInVm(req, deps);
      expect(result).toMatchObject({ reason: 'passed', verdict: 'pass' });
      expect(result.steps.map((s) => s.outcome)).toEqual(['success', 'success', 'success']);
      expect(result.steps[0]!.note).toBe(`checked out ${sha}`);
      expect(readFileSync(join(req.logDir, '02-step-2.log'), 'utf8')).toContain(
        'hello from the repo',
      );
      const second = readFileSync(join(req.logDir, '03-step-3.log'), 'utf8');
      expect(second).toContain('env ok true macOS refs/heads/main');
      expect(second).toContain(sha);
      expect(second).toContain('commits=1 tags=[]');
      expect(second).toContain('no secret');
      expect(readdirSync(req.logDir)).toContain('00-checkout.log');
      expect(result.timings.cloneSeconds).toBeGreaterThan(0);
      expect(vmRemains(deps.vm)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the workspace is empty until the checkout step',
    async () => {
      await waitForFreeSlot();
      const req = request('no-checkout-yet', [step(1, 'ls -A; test -f hello.txt'), checkout(2)]);
      const deps = realDeps();
      const result = await runInVm(req, deps);
      expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
      expect(result.steps.map((s) => s.outcome)).toEqual(['failure', 'skipped']);
      expect(vmRemains(deps.vm)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a failing step is step-failed and leaves no VM',
    async () => {
      await waitForFreeSlot();
      const req = request('fail', [step(1, 'echo before; exit 7'), step(2, 'echo never')]);
      const deps = realDeps();
      const result = await runInVm(req, deps);
      expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
      expect(result.steps.map((s) => s.outcome)).toEqual(['failure', 'skipped']);
      expect(result.steps[0]!.exitCode).toBe(7);
      expect(vmRemains(deps.vm)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a step that leaves a background child holding its output ends when its script exits',
    async () => {
      await waitForFreeSlot();
      const req = request('background', [
        step(1, 'sleep 6001 &\necho started', { shell: 'default' }),
        step(2, 'pgrep -f "sleep 6001" > /dev/null && echo child still running'),
      ]);
      const deps = realDeps();
      const result = await runInVm(req, deps);
      expect(result).toMatchObject({ reason: 'passed', verdict: 'pass' });
      expect(result.steps[0]!.seconds).toBeLessThan(30);
      expect(logOf(req, '01-step-1.log')).toContain('started');
      expect(logOf(req, '02-step-2.log')).toContain('child still running');
      expect(vmRemains(deps.vm)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a step that ignores SIGTERM is killed with its whole process group at its timeout',
    async () => {
      await waitForFreeSlot();
      const req = request('step-timeout', [
        step(1, "trap '' TERM\nsleep 6002 &\nsleep 6003", { timeoutMinutes: 0.25 }),
        noSurvivor(2, 'sleep 600[23]'),
      ]);
      const deps = realDeps();
      const result = await runInVm(req, deps);
      expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
      expect(result.steps.map((s) => s.outcome)).toEqual(['timeout', 'success']);
      expect(logOf(req, '02-step-2.log')).toContain('no survivor');
      expect(vmRemains(deps.vm)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the job timeout ends a long step, skips the rest, and leaves no VM',
    async () => {
      await waitForFreeSlot();
      const req = request(
        'job-timeout',
        [step(1, 'echo working\nsleep 6004'), step(2, 'echo never', { when: 'always' })],
        {},
        0.75,
      );
      const deps = realDeps();
      const result = await runInVm(req, deps);
      expect(result).toMatchObject({ reason: 'timeout', verdict: 'fail' });
      expect(result.steps.map((s) => s.outcome)).toEqual(['timeout', 'skipped']);
      expect(logOf(req, '01-step-1.log')).toContain('working');
      expect(vmRemains(deps.vm)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an interrupt mid-step ends the run as interrupted and leaves no VM',
    async () => {
      await waitForFreeSlot();
      const req = request('interrupt', [step(1, 'echo waiting\nsleep 6005')]);
      const interrupt = new AbortController();
      const deps = realDeps(interrupt.signal);
      // Interrupt a few seconds after the step starts in the guest.
      const tart = {
        ...deps.tart,
        exec: async (...args: Parameters<typeof deps.tart.exec>) => {
          if (args[2]?.stdin?.startsWith('# hugi-step 1\n')) {
            setTimeout(() => interrupt.abort(), 5000);
          }
          return deps.tart.exec(...args);
        },
      };
      const result = await runInVm(req, { ...deps, tart });
      expect(result).toMatchObject({ reason: 'interrupted', verdict: 'none' });
      expect(result.steps[0]!.outcome).toBe('failure');
      expect(logOf(req, '01-step-1.log')).toContain('waiting');
      expect(vmRemains(deps.vm)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!goldenEnabled)(
    'pinned tools resolve through the mise shims by per-tool version overrides',
    async () => {
      await waitForFreeSlot();
      // Versions other than the golden image's own defaults, so only the overrides can select them.
      const req = request(
        'golden-tools',
        [
          step(
            1,
            'command -v node\nnode --version\npnpm --version\necho "/opt/added" >> "$GITHUB_PATH"',
          ),
          step(2, 'echo "PATH=$PATH"'),
        ],
        { image: GOLDEN_IMAGE, tools: ['node@22.11.0', 'pnpm@10.0.0'] },
      );
      const deps = realDeps();
      const result = await runInVm(req, deps);
      expect(result).toMatchObject({ reason: 'passed', verdict: 'pass' });
      const versions = logOf(req, '01-step-1.log');
      expect(versions).toContain('/.local/share/mise/shims/node');
      expect(versions).toContain('v22.11.0');
      expect(versions).toContain('10.0.0');
      expect(logOf(req, '02-step-2.log')).toMatch(
        /PATH=\/opt\/added:\/Users\/admin\/\.local\/share\/mise\/shims:/,
      );
      expect(vmRemains(deps.vm)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
