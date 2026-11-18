/* oxlint-disable node/no-sync, promise/avoid-new, promise/prefer-await-to-then, typescript/parameter-properties -- test support: simple fixtures and a hand-rolled fake */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ActionStep, PlanStep, RunStep, StepPlan } from '../lane/step-plan';
import { advanceUntilSettled, FakeClock, FakeTart, settle } from './fake-tart';
import type { FakeGuest } from './fake-tart';
import { stepFiles } from './guest-paths';
import { KILL_GROUP_MARKER } from './housekeeping';
import { runInVm, VM_NAME_PREFIX } from './lifecycle';
import type { RunDeps } from './lifecycle';
import type { RunRequest } from './run-request';

let logDir: string;
beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'hugi-vm-test-'));
});
afterEach(() => {
  rmSync(logDir, { force: true, recursive: true });
});

const runStep = (index: number, overrides: Partial<RunStep> = {}): RunStep => ({
  continueOnError: false,
  env: {},
  index,
  kind: 'run',
  name: `Step ${index}`,
  script: `echo step ${index}`,
  shell: 'bash',
  when: 'success',
  ...overrides,
});

const planOf = (steps: PlanStep[], overrides: Partial<StepPlan> = {}): StepPlan => ({
  env: { PLAN_VAR: 'plan' },
  lane: { job: 'test', matrix: {}, workflow: '.github/workflows/ci.yml' },
  name: 'test',
  steps,
  timeoutMinutes: 10,
  ...overrides,
});

const requestOf = (
  steps: PlanStep[],
  overrides: Partial<RunRequest> = {},
  plan: Partial<StepPlan> = {},
): RunRequest => ({
  event: {
    event: 'push',
    refName: 'main',
    refType: 'branch',
    repository: 'dbtlr/hugi',
    sha: 'abc123',
  },
  image: 'hugi-golden',
  logDir,
  plan: planOf(steps, plan),
  source: { cloneUrl: 'https://github.com/dbtlr/hugi.git', kind: 'remote' },
  tools: [],
  ...overrides,
});

type Harness = {
  tart: FakeTart;
  clock: FakeClock;
  deps: RunDeps;
  warnings: string[];
  interrupt: AbortController;
};

function harness(guest: FakeGuest = { steps: {} }): Harness {
  const clock = new FakeClock();
  const tart = new FakeTart(clock, guest);
  const warnings: string[] = [];
  const interrupt = new AbortController();
  const deps: RunDeps = {
    clock,
    interrupt: interrupt.signal,
    newId: () => 'test1',
    tart,
    warn: (message) => warnings.push(message),
  };
  return { clock, deps, interrupt, tart, warnings };
}

const vmName = `${VM_NAME_PREFIX}test1`;
const run = (h: Harness, request: RunRequest) =>
  advanceUntilSettled(h.clock, runInVm(request, h.deps));
const deleted = (h: Harness) => h.tart.events.includes(`delete ${vmName}`);
const stopped = (h: Harness) => h.tart.events.includes(`stop ${vmName}`);
/** The process-group files of the steps the runner killed. */
const killedGroups = (h: Harness) =>
  h.tart.execs.filter((call) => call.argv[3] === KILL_GROUP_MARKER).map((call) => call.argv[4]);

test('a passing plan clones, sizes, boots, checks out, runs every step, and deletes the VM', async () => {
  const h = harness({ steps: { 1: { output: 'hello\n', takesMs: 2000 }, 2: {} } });
  const result = await run(h, requestOf([runStep(1, { name: 'Say Hello' }), runStep(2)]));

  expect(result.verdict).toBe('pass');
  expect(result.reason).toBe('passed');
  expect(result.steps.map((step) => step.outcome)).toEqual(['success', 'success']);
  expect(result.steps[0]!.seconds).toBe(2);
  expect(h.tart.events).toEqual([
    `clone hugi-golden ${vmName}`,
    `set ${vmName} 4 4096`,
    `run ${vmName}`,
    'checkout',
    'step 1',
    'step 2',
    `stop ${vmName}`,
    `delete ${vmName}`,
  ]);
  expect(readFileSync(join(logDir, '01-say-hello.log'), 'utf8')).toBe('hello\n');
  expect(readFileSync(join(logDir, '00-checkout.log'), 'utf8')).toBe('cloning\n');
  expect(result.steps[0]!.logFile).toBe(join(logDir, '01-say-hello.log'));
  expect(result.timings.totalSeconds).toBeGreaterThanOrEqual(2);
});

test('a local source mounts its snapshot read-only; a remote source mounts nothing', async () => {
  const local = harness();
  await run(local, requestOf([], { source: { kind: 'local', path: '/mock/snapshot' } }));
  expect(local.tart.shares).toEqual([[{ hostPath: '/mock/snapshot', name: 'source' }]]);

  const remote = harness();
  await run(remote, requestOf([]));
  expect(remote.tart.shares).toEqual([[]]);
});

test('GITHUB_ENV and GITHUB_PATH from one step reach the next step', async () => {
  const h = harness({
    steps: {
      1: { appendsEnv: 'FROM_FILE=hi there\nBLOB<<EOF\na\nb\nEOF\n', appendsPath: '/custom/bin\n' },
    },
  });
  await run(h, requestOf([runStep(1), runStep(2, { env: { PLAN_VAR: 'step' } })]));
  const second = h.tart.launcherFor(2);
  expect(second).toContain("export FROM_FILE='hi there'");
  expect(second).toContain("export BLOB='a\nb'");
  expect(second).toContain('export PATH="/custom/bin:$HOME/.local/share/mise/shims:');
  expect(second).toContain("export PLAN_VAR='step'");
  expect(h.tart.launcherFor(1)).toContain("export PLAN_VAR='plan'");
  expect(second).toContain("export GITHUB_SHA='abc123'");
});

test('each step gets fresh command files, and their values accumulate across steps', async () => {
  const h = harness({
    steps: {
      1: { appendsEnv: 'A=1\n', appendsPath: '/one\n' },
      2: { appendsEnv: 'B=2\n', appendsPath: '/two\n' },
    },
  });
  await run(h, requestOf([runStep(1), runStep(2), runStep(3)]));
  expect(h.tart.launcherFor(1)).toContain(`export GITHUB_ENV='${stepFiles(1).env}'`);
  expect(h.tart.launcherFor(2)).toContain(`: > '${stepFiles(2).env}'`);
  const third = h.tart.launcherFor(3);
  expect(third).toContain("export A='1'");
  expect(third).toContain("export B='2'");
  expect(third).toContain('export PATH="/two:/one:$HOME/');
});

test('an invalid GITHUB_ENV fails its step as on GitHub, and later steps see none of it', async () => {
  const h = harness({ steps: { 1: { appendsEnv: 'GOOD=1\nNOTE<<EOF\nno end\n' } } });
  const result = await run(h, requestOf([runStep(1), runStep(2, { when: 'always' })]));
  expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
  expect(result.steps[0]).toMatchObject({ exitCode: 0, outcome: 'failure' });
  expect(result.detail).toContain("Matching delimiter not found 'EOF'");
  expect(readFileSync(result.steps[0]!.logFile!, 'utf8')).toContain(
    "Error: Invalid environment variable value. Matching delimiter not found 'EOF'",
  );
  expect(h.tart.launcherFor(2)).not.toContain('GOOD');
});

test("an invalid GITHUB_OUTPUT fails its step with GitHub's wording", async () => {
  const h = harness({
    steps: { 1: { appendsOutput: 'files=a\nb\n' }, 2: { appendsOutput: 'ok=1\n' } },
  });
  const result = await run(h, requestOf([runStep(1), runStep(2, { when: 'always' })]));
  expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
  expect(result.steps.map((step) => step.outcome)).toEqual(['failure', 'success']);
  expect(result.steps[0]!.error).toBe(
    "Unable to process file command 'output' successfully. Invalid format 'b'",
  );
  expect(readFileSync(result.steps[0]!.logFile!, 'utf8')).toContain(
    "Error: Unable to process file command 'output' successfully.",
  );
  expect(h.tart.launcherFor(2)).toContain(`export GITHUB_OUTPUT='${stepFiles(2).output}'`);
});

test('steps run in their working directory with the right shell', async () => {
  const h = harness();
  await run(
    h,
    requestOf([
      runStep(1, { workingDirectory: 'packages/app' }),
      runStep(2, { shell: 'sh' }),
      runStep(3, { shell: 'default' }),
    ]),
  );
  expect(h.tart.launcherFor(1)).toContain("if cd '/Users/admin/hugi/workspace/packages/app'; then");
  expect(h.tart.launcherFor(1)).toContain("'bash' '--noprofile' '--norc' '-eo' 'pipefail'");
  expect(h.tart.launcherFor(2)).toContain("'sh' '-e' '");
  expect(h.tart.launcherFor(3)).toContain("'bash' '-e' '");
});

test('pinned tools reach every step as mise version overrides, with no mise wrapper', async () => {
  const h = harness();
  await run(h, requestOf([runStep(1)], { tools: ['node@22.23.2', 'pnpm@10.0.0'] }));
  for (const index of [0, 1]) {
    const launcher = h.tart.launcherFor(index);
    expect(launcher).toContain("export MISE_NODE_VERSION='22.23.2'");
    expect(launcher).toContain("export MISE_PNPM_VERSION='10.0.0'");
    expect(launcher).not.toContain("'mise' 'x'");
  }
});

test('a PATH from the plan env, a step env, or GITHUB_ENV replaces the base PATH; GITHUB_PATH stays in front', async () => {
  const h = harness({
    steps: { 1: { appendsPath: '/added\n' }, 2: { appendsEnv: 'PATH=/from/file\n' } },
  });
  await run(
    h,
    requestOf(
      [runStep(1), runStep(2), runStep(3), runStep(4, { env: { PATH: '/from/step' } })],
      {},
      { env: { PATH: '/from/plan' } },
    ),
  );
  expect(h.tart.launcherFor(1)).toContain('export PATH="/from/plan"');
  expect(h.tart.launcherFor(2)).toContain('export PATH="/added:/from/plan"');
  expect(h.tart.launcherFor(3)).toContain('export PATH="/added:/from/file"');
  expect(h.tart.launcherFor(4)).toContain('export PATH="/added:/from/step"');
});

const actionStep = (
  index: number,
  uses: string,
  overrides: Partial<ActionStep> = {},
): ActionStep => ({
  continueOnError: false,
  env: {},
  index,
  kind: 'action',
  name: uses,
  uses,
  when: 'success',
  with: {},
  ...overrides,
});

test('action steps other than the checkout are skipped, never executed', async () => {
  const h = harness();
  const result = await run(h, requestOf([actionStep(1, 'Swatinem/rust-cache@v2'), runStep(2)]));
  expect(result.reason).toBe('passed');
  expect(result.steps[0]).toMatchObject({ index: 1, outcome: 'skipped' });
  expect(h.tart.events).not.toContain('materialize');
});

test('the workspace stays empty until the first checkout step, which materializes it', async () => {
  const h = harness({ steps: { 1: {}, 3: {} } });
  const result = await run(
    h,
    requestOf([
      runStep(1),
      actionStep(2, 'actions/checkout@v4'),
      runStep(3),
      actionStep(4, 'actions/checkout@v4'),
    ]),
  );
  expect(result.reason).toBe('passed');
  expect(h.tart.events.filter((event) => !event.includes(vmName))).toEqual([
    'checkout',
    'step 1',
    'materialize',
    'step 3',
  ]);
  expect(result.steps[1]).toMatchObject({
    index: 2,
    note: 'checked out abc123',
    outcome: 'success',
  });
  expect(readFileSync(result.steps[1]!.logFile!, 'utf8')).toContain('checked out abc123');
  // A second checkout of the same commit has nothing left to do.
  expect(result.steps[3]).toMatchObject({ index: 4, outcome: 'skipped' });
});

test('a checkout step after a failure is skipped, so the workspace stays empty', async () => {
  const h = harness({ steps: { 1: { exitCode: 1 } } });
  const result = await run(h, requestOf([runStep(1), actionStep(2, 'actions/checkout@v4')]));
  expect(result.reason).toBe('step-failed');
  expect(result.steps[1]).toMatchObject({ outcome: 'skipped' });
  expect(h.tart.events).not.toContain('materialize');
});

test('a checkout step that fails is infrastructure, and no later step runs', async () => {
  const h = harness({ materializeExitCode: 128, steps: {} });
  const result = await run(
    h,
    requestOf([actionStep(1, 'actions/checkout@v4'), runStep(2, { when: 'always' })]),
  );
  expect(result).toMatchObject({ reason: 'infrastructure', verdict: 'none' });
  expect(result.detail).toContain('exit code 128');
  expect(result.steps.map((step) => step.outcome)).toEqual(['failure', 'skipped']);
  expect(h.tart.events).not.toContain('step 2');
  expect(deleted(h)).toBe(true);
  expect(h.tart.events).not.toContain('step 1');
});

test('a failing step fails the run; success steps are skipped, always and failure steps run', async () => {
  const h = harness({ steps: { 1: { exitCode: 3 } } });
  const result = await run(
    h,
    requestOf([
      runStep(1),
      runStep(2),
      runStep(3, { when: 'always' }),
      runStep(4, { when: 'failure' }),
    ]),
  );
  expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
  expect(result.detail).toContain('exit code 3');
  expect(result.steps.map((step) => step.outcome)).toEqual([
    'failure',
    'skipped',
    'success',
    'success',
  ]);
  expect(result.steps[0]!.exitCode).toBe(3);
  expect(deleted(h)).toBe(true);
});

test('a failure step does not run when nothing failed', async () => {
  const h = harness();
  const result = await run(h, requestOf([runStep(1), runStep(2, { when: 'failure' })]));
  expect(result.reason).toBe('passed');
  expect(result.steps[1]!.outcome).toBe('skipped');
});

test('continueOnError keeps the run green and later success steps running', async () => {
  const h = harness({ steps: { 1: { exitCode: 1 } } });
  const result = await run(h, requestOf([runStep(1, { continueOnError: true }), runStep(2)]));
  expect(result).toMatchObject({ reason: 'passed', verdict: 'pass' });
  expect(result.steps.map((step) => step.outcome)).toEqual(['failure', 'success']);
});

test('a step timeout kills that step, fails the run, and still runs always steps', async () => {
  const h = harness({ steps: { 1: { hangs: true } } });
  const result = await run(
    h,
    requestOf([runStep(1, { timeoutMinutes: 1 }), runStep(2), runStep(3, { when: 'always' })]),
  );
  expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
  expect(result.steps.map((step) => step.outcome)).toEqual(['timeout', 'skipped', 'success']);
  expect(result.steps[0]!.seconds).toBeGreaterThanOrEqual(60);
  expect(killedGroups(h)).toEqual([stepFiles(1).processGroup]);
  expect(deleted(h)).toBe(true);
});

test('the job timeout spans all steps: it kills the running step and skips the rest', async () => {
  const h = harness({ steps: { 1: { takesMs: 40_000 }, 2: { hangs: true } } });
  const result = await run(
    h,
    requestOf([runStep(1), runStep(2), runStep(3, { when: 'always' })], {}, { timeoutMinutes: 1 }),
  );
  expect(result).toMatchObject({ reason: 'timeout', verdict: 'fail' });
  expect(result.steps.map((step) => step.outcome)).toEqual(['success', 'timeout', 'skipped']);
  expect(result.detail).toContain('step 2');
  expect(killedGroups(h)).toEqual([stepFiles(2).processGroup]);
  expect(stopped(h) && deleted(h)).toBe(true);
});

test('a step finishes when its exit status appears, and its guest log is copied to the host', async () => {
  const h = harness({ steps: { 1: { output: 'server started\n', takesMs: 3000 } } });
  const result = await run(h, requestOf([runStep(1)]));
  expect(result.steps[0]).toMatchObject({ exitCode: 0, outcome: 'success', seconds: 3 });
  expect(readFileSync(result.steps[0]!.logFile!, 'utf8')).toBe('server started\n');
});

test('a checkout that outlasts the job deadline is infrastructure, and the VM is deleted', async () => {
  const h = harness({ checkoutHangs: true, steps: {} });
  const result = await run(h, requestOf([runStep(1)], {}, { timeoutMinutes: 1 }));
  expect(result).toMatchObject({
    detail: 'fetching the source timed out',
    reason: 'infrastructure',
    verdict: 'none',
  });
  expect(h.tart.events).not.toContain('step 1');
  expect(stopped(h) && deleted(h)).toBe(true);
});

test('a VM that exits mid-step is infrastructure, not a step failure', async () => {
  const h = harness({ steps: { 1: {}, 2: { hangs: true, vmExits: true } } });
  const result = await run(h, requestOf([runStep(1), runStep(2), runStep(3, { when: 'always' })]));
  expect(result).toMatchObject({ reason: 'infrastructure', verdict: 'none' });
  expect(result.detail).toContain('the VM exited');
  expect(result.detail).toContain('step 2');
  expect(result.steps.map((step) => step.outcome)).toEqual(['success', 'failure', 'skipped']);
  expect(deleted(h)).toBe(true);
});

test('a guest agent that stops answering mid-step is infrastructure', async () => {
  const h = harness({ steps: { 1: { agentLost: true, hangs: true } } });
  const result = await run(h, requestOf([runStep(1)]));
  expect(result).toMatchObject({ reason: 'infrastructure', verdict: 'none' });
  expect(result.detail).toContain('stopped answering');
  expect(deleted(h)).toBe(true);
});

test('a wedged kill and a wedged log copy hit their deadlines, and the run still ends and cleans up', async () => {
  const h = harness({ steps: { 1: { hangs: true } }, wedged: { kill: true, logCopy: true } });
  const result = await run(h, requestOf([runStep(1, { timeoutMinutes: 1 })]));
  expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
  expect(result.steps[0]!.outcome).toBe('timeout');
  expect(h.warnings.some((warning) => warning.includes('could not kill step 1'))).toBe(true);
  expect(readFileSync(result.steps[0]!.logFile!, 'utf8')).toContain('could not copy');
  expect(deleted(h)).toBe(true);
});

test('status polls that never answer hit their deadlines and count as a lost guest agent', async () => {
  const h = harness({ steps: { 1: { hangs: true } }, wedged: { statusPoll: true } });
  const result = await run(h, requestOf([runStep(1)]));
  expect(result).toMatchObject({ reason: 'infrastructure', verdict: 'none' });
  expect(result.detail).toContain('stopped answering');
  expect(result.steps[0]!.seconds).toBeGreaterThanOrEqual(90);
  expect(deleted(h)).toBe(true);
});

test('a wedged tart stop is cut off, the tart run process killed, and the VM still deleted', async () => {
  const h = harness({ steps: {}, wedged: { stop: true } });
  const result = await run(h, requestOf([runStep(1)]));
  expect(result.reason).toBe('passed');
  expect(h.tart.events.slice(-3)).toEqual([`stop ${vmName}`, `kill ${vmName}`, `delete ${vmName}`]);
  expect(h.warnings.some((warning) => warning.includes('could not stop'))).toBe(true);
  expect(h.warnings.some((warning) => warning.includes('leaked'))).toBe(false);
});

test('a clone failure is infrastructure, boots nothing, and deletes any VM the clone left', async () => {
  const h = harness({ cloneError: 'no such image', steps: {} });
  const result = await run(h, requestOf([runStep(1)]));
  expect(result).toMatchObject({ reason: 'infrastructure', verdict: 'none' });
  expect(result.detail).toContain('no such image');
  expect(h.tart.events.some((event) => event.startsWith('run'))).toBe(false);
  // tart clone can fail after it has created the VM, so the run tries once to delete it.
  expect(h.tart.events.filter((event) => event === `delete ${vmName}`)).toHaveLength(1);
});

test('a VM a failed clone may have left that cannot be deleted is a warning naming it', async () => {
  const h = harness({ cloneError: 'prune failed', deleteErrors: 1, steps: {} });
  const result = await run(h, requestOf([runStep(1)]));
  expect(result).toMatchObject({ reason: 'infrastructure', verdict: 'none' });
  expect(h.warnings.some((warning) => warning.includes(vmName))).toBe(true);
});

test('a VM that exits during boot is infrastructure and is cleaned up', async () => {
  const h = harness({ probeFailures: Infinity, steps: {}, vmExitsOnBoot: 1 });
  const result = await run(h, requestOf([runStep(1)]));
  expect(result).toMatchObject({ reason: 'infrastructure', verdict: 'none' });
  expect(result.detail).toContain('exited during boot');
  expect(result.detail).toContain('no capacity');
  expect(stopped(h) && deleted(h)).toBe(true);
});

test('a guest that never answers hits the boot deadline', async () => {
  const h = harness({ probeFailures: Infinity, steps: {} });
  h.deps = { ...h.deps, tuning: { bootTimeoutMs: 10_000 } };
  const result = await run(h, requestOf([runStep(1)]));
  expect(result).toMatchObject({ reason: 'infrastructure', verdict: 'none' });
  expect(result.detail).toContain('did not answer');
  expect(deleted(h)).toBe(true);
});

test('the runner waits through failed probes until the guest answers', async () => {
  const h = harness({ probeFailures: 3, steps: {} });
  const result = await run(h, requestOf([runStep(1)]));
  expect(result.reason).toBe('passed');
});

test('a failed checkout is infrastructure, runs no steps, and cleans up', async () => {
  const h = harness({ checkoutExitCode: 128, steps: {} });
  const result = await run(h, requestOf([runStep(1)]));
  expect(result).toMatchObject({ reason: 'infrastructure', verdict: 'none' });
  expect(result.detail).toContain('exit code 128');
  expect(h.tart.events).not.toContain('step 1');
  expect(deleted(h)).toBe(true);
});

test('an error thrown mid-run becomes infrastructure, keeps the finished steps, and still deletes the VM', async () => {
  const h = harness({ steps: { 1: { output: 'one\n' }, 2: { throws: 'tart exploded' } } });
  const result = await run(h, requestOf([runStep(1), runStep(2)]));
  expect(result).toMatchObject({ reason: 'infrastructure', verdict: 'none' });
  expect(result.detail).toContain('tart exploded');
  expect(result.steps).toHaveLength(1);
  expect(result.steps[0]).toMatchObject({ index: 1, outcome: 'success' });
  expect(readFileSync(result.steps[0]!.logFile!, 'utf8')).toBe('one\n');
  expect(stopped(h) && deleted(h)).toBe(true);
});

test('an interrupt during a step kills it, cleans up, and reports interrupted with no verdict', async () => {
  const h = harness({ steps: { 1: { hangs: true } } });
  const pending = runInVm(requestOf([runStep(1), runStep(2, { when: 'always' })]), h.deps);
  await settle();
  expect(h.tart.events).toContain('step 1');
  h.interrupt.abort();
  const result = await advanceUntilSettled(h.clock, pending);
  expect(result).toMatchObject({ reason: 'interrupted', verdict: 'none' });
  expect(result.steps.map((step) => step.outcome)).toEqual(['failure', 'skipped']);
  expect(killedGroups(h)).toEqual([stepFiles(1).processGroup]);
  expect(stopped(h) && deleted(h)).toBe(true);
});

test('an interrupt before the run starts clones nothing', async () => {
  const h = harness();
  h.interrupt.abort();
  const result = await run(h, requestOf([runStep(1)]));
  expect(result).toMatchObject({ reason: 'interrupted', verdict: 'none' });
  expect(h.tart.events).toEqual([]);
});

test('an interrupt while the VM boots cleans up', async () => {
  const h = harness({ probeFailures: Infinity, steps: {} });
  const pending = runInVm(requestOf([runStep(1)]), h.deps);
  await settle();
  h.interrupt.abort();
  const result = await advanceUntilSettled(h.clock, pending);
  expect(result).toMatchObject({ reason: 'interrupted', verdict: 'none' });
  expect(stopped(h) && deleted(h)).toBe(true);
});

test('a failed delete is retried, then warned about loudly, never swallowed', async () => {
  const h = harness({ deleteErrors: 10, steps: {} });
  const result = await run(h, requestOf([runStep(1)]));
  expect(result.reason).toBe('passed');
  expect(h.tart.events.filter((event) => event.startsWith('delete'))).toHaveLength(3);
  expect(h.warnings).toHaveLength(3);
  expect(h.warnings.at(-1)).toContain('leaked');
});

test('a delete that succeeds on retry leaves only warnings for the failed attempts', async () => {
  const h = harness({ deleteErrors: 1, steps: {} });
  await run(h, requestOf([runStep(1)]));
  expect(h.tart.events.filter((event) => event.startsWith('delete'))).toHaveLength(2);
  expect(h.warnings).toHaveLength(1);
});

test('tools are installed first, as a step named "Install tools" that runs mise install', async () => {
  const h = harness();
  const result = await run(h, requestOf([runStep(1)], { tools: ['bun@1.4.4', 'node@22'] }));
  expect(result.reason).toBe('passed');
  expect(result.steps.map((step) => [step.index, step.name])).toEqual([
    [0, 'Install tools'],
    [1, 'Step 1'],
  ]);
  expect(h.tart.launcherFor(0)).toContain("mise install 'bun@1.4.4' 'node@22'");
  expect(h.tart.launcherFor(0)).not.toContain("'mise' 'x'");
  expect(h.tart.events.indexOf('step 0')).toBeLessThan(h.tart.events.indexOf('step 1'));
});

test('no tools means no install step', async () => {
  const h = harness();
  const result = await run(h, requestOf([runStep(1)]));
  expect(result.steps.map((step) => step.name)).toEqual(['Step 1']);
});

test('a failed tool install is a step failure with a fail verdict, not infrastructure; only always and failure steps run after it', async () => {
  const h = harness({ steps: { 0: { exitCode: 1, output: 'no version matching bun@9\n' } } });
  const result = await run(
    h,
    requestOf([runStep(1), runStep(2, { when: 'always' }), runStep(3, { when: 'failure' })], {
      tools: ['bun@9'],
    }),
  );
  expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
  expect(result.detail).toContain('Install tools');
  expect(result.steps.map((step) => [step.name, step.outcome])).toEqual([
    ['Install tools', 'failure'],
    ['Step 1', 'skipped'],
    ['Step 2', 'success'],
    ['Step 3', 'success'],
  ]);
  expect(readFileSync(join(logDir, '00-install-tools.log'), 'utf8')).toContain('no version');
  expect(deleted(h)).toBe(true);
});
