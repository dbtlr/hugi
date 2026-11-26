/* oxlint-disable node/no-sync -- test support: reads the step's host log and builds throwaway guest directories */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ActionStep, PlanStep, RunStep } from '../lane/step-plan';
import type { MiseActionSettings } from '../toolchain/types';
import {
  advanceUntilSettled,
  FAKE_MISE_PROBE,
  FakeClock,
  FakeTart,
  readableGuestScript,
} from './fake-tart';
import type { FakeGuest, FakeMiseAction, MiseActionPhase } from './fake-tart';
import { runInVm } from './lifecycle';
import {
  hasLockFile,
  managedPaths,
  lockFilePlaces,
  miseVersion,
  overlapConflicts,
  parseProbe,
  setsMonorepoRoots,
} from './mise-action-judging';
import type { RunRequest } from './run-request';
import { parseConfigListing } from './tool-environment';

const WORKSPACE = '/Users/admin/hugi/workspace';
const SHIMS = '/Users/admin/.local/share/mise/shims';

let logDir: string;
beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'hugi-mise-action-test-'));
});
afterEach(() => {
  rmSync(logDir, { force: true, recursive: true });
});

const DEFAULTS: MiseActionSettings = {
  addShimsToPath: true,
  env: true,
  experimental: false,
  exportPath: true,
  install: true,
  installArgs: [],
  logLevel: 'info',
  monorepo: true,
  reshim: false,
};

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

const checkout = () => actionStep(1, 'actions/checkout@v7');
const miseStep = (overrides: Partial<ActionStep> = {}) =>
  actionStep(2, 'jdx/mise-action@v5', { name: 'Set up mise', ...overrides });

/** A lane of the checkout, the action at step 2 with `settings`, and `later` steps. */
function requestOf(
  options: {
    settings?: Partial<MiseActionSettings>;
    step?: Partial<ActionStep>;
    later?: PlanStep[];
    planEnv?: Record<string, string>;
    tools?: string[];
  } = {},
): RunRequest {
  const step = miseStep(options.step);
  return {
    event: { event: 'push', refName: 'main', refType: 'branch', repository: 'o/r', sha: 'abc123' },
    image: 'hugi-golden',
    logDir,
    miseActions: [
      {
        index: step.index,
        kind: 'mise-action',
        name: step.name,
        settings: { ...DEFAULTS, ...options.settings },
        uses: step.uses,
      },
    ],
    plan: {
      env: options.planEnv ?? {},
      lane: { job: 'test', matrix: {}, workflow: '.github/workflows/ci.yml' },
      name: 'test',
      steps: [checkout(), step, ...(options.later ?? [runStep(3)])],
      timeoutMinutes: 30,
    },
    source: { cloneUrl: 'https://github.com/o/r.git', kind: 'remote' },
    toolSource: 'workflow',
    tools: options.tools ?? ['node@22.23.2'],
  };
}

const TOOL_ENVIRONMENT = JSON.stringify({ PATH: '/wf/node:/img/bun:/usr/bin' });

function harness(miseAction: FakeMiseAction = {}, guest: Partial<FakeGuest> = {}) {
  const clock = new FakeClock();
  const tart = new FakeTart(clock, {
    mise: { toolEnvironment: TOOL_ENVIRONMENT },
    miseAction,
    steps: {},
    ...guest,
  });
  const run = (request: RunRequest) =>
    advanceUntilSettled(
      clock,
      runInVm(request, {
        clock,
        interrupt: new AbortController().signal,
        newId: () => 'test1',
        tart,
        warn: () => undefined,
      }),
    );
  const phases = () =>
    tart.events.filter((event) => event.startsWith('mise action ')).map((event) => event.slice(12));
  // Read with its lines unquoted, so a test can match them as `guestScript` was given them.
  const script = (phase: MiseActionPhase) => readableGuestScript(tart.miseActionScript(2, phase));
  return { phases, run, script, tart };
}

const probe = (overrides: Partial<typeof FAKE_MISE_PROBE>) =>
  JSON.stringify({ ...FAKE_MISE_PROBE, ...overrides });
const lines = (...records: object[]) =>
  `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
const listing = (...files: string[]) =>
  lines(
    { kind: 'workspace', real: WORKSPACE },
    ...files.map((path) => ({ kind: 'file', path, real: path })),
  );
const listed = (role: string, dir: string, executables: string[]) => ({
  dir,
  executables,
  real: dir,
  role,
});
const outcomes = (result: { steps: readonly { name: string; outcome: string }[] }) =>
  result.steps.map((step) => [step.name, step.outcome]);

const ALL_PHASES: MiseActionPhase[] = [
  'probe',
  'bins',
  'prepare',
  'listing',
  'requests',
  'install-check',
  'install',
  'overlap',
  'ls',
  'env',
];
/** The scripts that run with the step's environment and isolation: all but the workflow bins'. */
const STEP_PHASES = ALL_PHASES.filter((phase) => phase !== 'bins');

describe('a jdx/mise-action step (ADR-0007)', () => {
  test("runs at its own place after the checkout, doing the action's steps in order", async () => {
    const h = harness();
    const result = await h.run(requestOf());
    expect(result.reason).toBe('passed');
    expect(outcomes(result)).toEqual([
      ['Install tools', 'success'],
      ['actions/checkout@v7', 'success'],
      ['Set up mise', 'success'],
      ['Step 3', 'success'],
    ]);
    const materialized = h.tart.events.indexOf('materialize');
    expect(h.tart.events.slice(materialized, materialized + 12)).toEqual([
      'materialize',
      ...ALL_PHASES.map((phase) => `mise action ${phase}`),
      'step 3',
    ]);
  });

  test('later steps get what it wrote: its variables, its PATH entries in front, and the shims', async () => {
    const h = harness({
      environment: JSON.stringify({ FOO: 'bar', PATH: '/ignored' }),
      paths: '/cfg/nu/bin\n/cfg/bin\n',
    });
    await h.run(requestOf());
    const later = h.tart.launcherFor(3);
    expect(later).toContain(`'MISE_TRUSTED_CONFIG_PATHS=${WORKSPACE}'`);
    expect(later).toContain("'MISE_YES=1'");
    expect(later).toContain("'MISE_LOG_LEVEL=info'");
    expect(later).toContain("'FOO=bar'");
    expect(later).not.toContain('/ignored');
    expect(later).toContain(
      `export PATH="/cfg/nu/bin:/cfg/bin:/wf/node:${SHIMS}:/wf/node:/img/bun:/usr/bin"`,
    );
  });

  test("its own mise commands see only the repository's config, without Hugi's runner mise variables", async () => {
    const h = harness();
    await h.run(requestOf());
    for (const phase of STEP_PHASES) {
      const script = h.script(phase);
      expect(script).toContain("'MISE_CEILING_PATHS=/Users/admin/hugi'");
      expect(script).toContain("'MISE_CONFIG_DIR=/Users/admin/hugi/control/step-02/mise-config'");
      expect(script).toContain(
        "'MISE_GLOBAL_CONFIG_FILE=/Users/admin/hugi/control/step-02/mise-config/config.toml'",
      );
      expect(script).not.toContain('MISE_IGNORED_CONFIG_PATHS');
      expect(script).not.toContain('MISE_NODE_VERSION');
      expect(script).toContain('export PATH="');
    }
    expect(h.script('probe')).toContain("cd '/Users/admin/hugi/temp'");
    for (const phase of STEP_PHASES.slice(1)) {
      expect(h.script(phase)).toContain(`cd '${WORKSPACE}'`);
    }
  });

  test('finds the workflow tools bins in the tool environment, not the step environment', async () => {
    const h = harness();
    await h.run(
      requestOf({
        planEnv: { MISE_DATA_DIR: '/plan/mise' },
        step: { env: { HOME: '/step/home', XDG_DATA_HOME: '/step/data' } },
      }),
    );
    const bins = h.script('bins');
    expect(bins).toContain("cd '/Users/admin/hugi/temp'");
    expect(bins).toContain("mise bin-paths 'node@22.23.2'");
    expect(bins).toContain("'MISE_NODE_VERSION=22.23.2'");
    for (const name of ['MISE_DATA_DIR', 'XDG_DATA_HOME', 'HOME', 'MISE_CONFIG_DIR']) {
      expect(bins).not.toContain(`'${name}=`);
    }
    // The shims directory still follows the step's environment, by the action's rule.
    expect(h.script('probe')).toContain("'MISE_DATA_DIR=/plan/mise'");
  });

  test('a value of those names that the workflow, the step or an earlier step gives stays', async () => {
    const h = harness();
    await h.run(
      requestOf({
        later: [runStep(3)],
        planEnv: { MISE_IGNORED_CONFIG_PATHS: '/plan' },
        step: { env: { MISE_NODE_VERSION: '20' } },
      }),
    );
    expect(h.script('probe')).toContain("'MISE_IGNORED_CONFIG_PATHS=/plan'");
    expect(h.script('probe')).toContain("'MISE_NODE_VERSION=20'");
  });

  test('writes its defaults only where the step leaves them unset or empty, and each reaches its own later commands', async () => {
    const h = harness();
    await h.run(
      requestOf({
        settings: { experimental: true },
        step: { env: { MISE_LOG_LEVEL: 'warn', MISE_YES: '' } },
      }),
    );
    expect(h.script('probe')).not.toContain('MISE_EXPERIMENTAL');
    const prepare = h.script('prepare');
    expect(prepare).toContain("'MISE_EXPERIMENTAL=1'");
    expect(prepare).toContain("'MISE_YES=1'");
    expect(prepare).toContain("'MISE_LOG_LEVEL=warn'");
    const later = h.tart.launcherFor(3);
    expect(later).toContain("'MISE_YES=1'");
    expect(later).not.toContain('MISE_LOG_LEVEL');
  });

  test('writes mise_env first, over any value, so its first mise command sees it', async () => {
    const h = harness();
    await h.run(requestOf({ settings: { miseEnv: 'ci' }, step: { env: { MISE_ENV: 'dev' } } }));
    expect(h.script('probe')).toContain("'MISE_ENV=ci'");
    expect(h.tart.launcherFor(3)).toContain("'MISE_ENV=ci'");
  });

  test('puts the workflow tools ahead of the shims, in the tool environment order', async () => {
    const h = harness({ workflowBins: '/img/bun\n/wf/node\n' });
    await h.run(requestOf({ settings: { env: false }, tools: ['bun@1.4.4', 'node@22.23.2'] }));
    expect(h.script('bins')).toContain("mise bin-paths 'bun@1.4.4' 'node@22.23.2'");
    expect(h.tart.launcherFor(3)).toContain(
      `export PATH="/wf/node:/img/bun:${SHIMS}:/wf/node:/img/bun:/usr/bin"`,
    );
    // The step's own later commands run with them too, as the action's addPath gives them.
    expect(h.script('prepare')).toContain(`export PATH="/wf/node:/img/bun:${SHIMS}:`);
  });

  test('without add_shims_to_path, env or export_path, adds no shims and checks no overlap', async () => {
    const h = harness();
    await h.run(requestOf({ settings: { addShimsToPath: false, exportPath: false } }));
    expect(h.phases()).not.toContain('overlap');
    expect(h.phases()).not.toContain('bins');
    expect(h.tart.launcherFor(3)).not.toContain('shims');
    expect(h.script('env')).not.toContain('--paths');
  });

  test('checks the overlap when it exports PATH even without the shims', async () => {
    const h = harness();
    await h.run(requestOf({ settings: { addShimsToPath: false } }));
    expect(h.phases()).toContain('overlap');
  });

  test('runs reshim and its first mise command in the working directory', async () => {
    const h = harness();
    await h.run(requestOf({ settings: { reshim: true, workingDirectory: 'pkg/app' } }));
    const prepare = h.script('prepare');
    expect(prepare).toContain(`cd '${WORKSPACE}/pkg/app'`);
    expect(prepare.indexOf('mise reshim -f')).toBeLessThan(prepare.indexOf('mise --version'));
    for (const phase of STEP_PHASES.slice(1)) {
      expect(h.script(phase)).toContain(`cd '${WORKSPACE}/pkg/app'`);
    }
  });

  test('a working directory that does not exist fails at its first mise command, after the writes', async () => {
    const h = harness({ exitCodes: { prepare: 1 } });
    const result = await h.run(
      requestOf({ later: [runStep(3, { when: 'always' })], settings: { miseEnv: 'ci' } }),
    );
    expect(result.reason).toBe('step-failed');
    expect(h.phases()).toEqual(['probe', 'bins', 'prepare']);
    const later = h.tart.launcherFor(3);
    expect(later).toContain("'MISE_ENV=ci'");
    expect(later).toContain("'MISE_YES=1'");
    expect(later).toContain(SHIMS);
  });

  test('installs with --locked when a lock file lies between the working directory and the workspace root', async () => {
    const h = harness({
      installCheck: lines(
        ...lockFilePlaces('pkg/app').map(({ path }) => ({
          files: path === `${WORKSPACE}/pkg` ? ['mise.toml', 'mise.lock'] : [],
          path,
        })),
      ),
    });
    await h.run(
      requestOf({
        settings: { installArgs: ['nushell', 'npm:pnpm'], workingDirectory: 'pkg/app' },
      }),
    );
    expect(h.script('install')).toContain("mise install --locked 'nushell' 'npm:pnpm'");
    const check = h.script('install-check');
    for (const dir of [`${WORKSPACE}/pkg/app`, `${WORKSPACE}/pkg`, WORKSPACE]) {
      expect(check).toContain(`'${dir}/.config/mise'`);
    }
    expect(check).not.toContain("'/Users/admin/hugi/.config");
  });

  test('installs without --locked when no lock file is found, and installs nothing when install is false', async () => {
    const h = harness();
    await h.run(requestOf());
    expect(h.script('install')).toMatch(/^mise install$/m);
    const off = harness();
    await off.run(requestOf({ settings: { install: false } }));
    expect(off.phases()).not.toContain('install-check');
    expect(off.phases()).not.toContain('install');
  });

  test('asks about monorepo.config_roots only when monorepo is true', async () => {
    const h = harness();
    await h.run(requestOf());
    expect(h.script('install-check')).toContain('mise config get monorepo.config_roots');
    const off = harness();
    await off.run(requestOf({ settings: { monorepo: false } }));
    expect(off.script('install-check')).not.toContain('monorepo');
  });

  test('a failed install still runs the overlap check, then fails the step', async () => {
    const h = harness({ exitCodes: { install: 2 } });
    const result = await h.run(requestOf());
    expect(result.reason).toBe('step-failed');
    expect(result.detail).toContain('mise install exited with code 2');
    expect(h.phases()).toEqual([
      'probe',
      'bins',
      'prepare',
      'listing',
      'requests',
      'install-check',
      'install',
      'overlap',
    ]);
  });

  test('a config directory that shares the workflow tool directory passes the overlap check', async () => {
    const h = harness({
      overlap: lines(
        listed('config', '/wf/node', ['node']),
        listed('workflow', '/wf/node', ['node']),
      ),
    });
    expect((await h.run(requestOf())).reason).toBe('passed');
  });

  test('exports the variables without printing their values, and names them in the log', async () => {
    const h = harness({
      environment: JSON.stringify({ API_URL: 'secret-value-1', OTHER: 'secret-value-2' }),
    });
    const result = await h.run(requestOf());
    const log = readFileSync(join(logDir, '02-set-up-mise.log'), 'utf8');
    expect(log).toContain('API_URL');
    expect(log).toContain('OTHER');
    expect(log).not.toContain('secret-value');
    expect(h.script('env')).toContain('mise env --json >');
    expect(result.steps[2]?.note).toBe(
      'wrote 5 variables to GITHUB_ENV and 2 directories to GITHUB_PATH',
    );
  });

  test('a step env key that is not a shell name reaches every one of its mise commands, and the step runs', async () => {
    const h = harness();
    const result = await h.run(requestOf({ step: { env: { 'FOO-BAR': 'dash' } } }));
    expect(result.reason).toBe('passed');
    for (const phase of STEP_PHASES) {
      expect(h.script(phase)).toContain("'FOO-BAR=dash'");
    }
  });

  test('a name it exports that GITHUB_ENV can carry, such as A-B, reaches later steps', async () => {
    const h = harness({ environment: JSON.stringify({ 'A-B': 'v', FOO: 'bar' }) });
    const result = await h.run(requestOf());
    expect(result.reason).toBe('passed');
    expect(h.tart.launcherFor(3)).toContain("'A-B=v'");
    expect(h.tart.launcherFor(3)).toContain("'FOO=bar'");
  });

  test.each([
    ['A=B', "Invalid format 'v'"],
    ['C<<D', "Invalid value. Matching delimiter not found 'D<<ghadelimiter_"],
    ['E\nF', "Invalid format 'E'"],
  ])(
    "a name %p it exports fails the step with GitHub's runner's message, as it reads the name back from GITHUB_ENV",
    async (name, error) => {
      const message = `Unable to process file command 'env' successfully. ${error}`;
      const h = harness({
        // oxlint-disable-next-line sort-keys -- in write order: the bad name between two good ones
        environment: JSON.stringify({ EARLIER: 'kept', [name]: 'v', LATER: 'x' }),
        paths: '/cfg/bin\n',
      });
      const result = await h.run(
        requestOf({ later: [runStep(3), runStep(4, { when: 'always' })] }),
      );
      expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
      expect(outcomes(result).slice(2)).toEqual([
        ['Set up mise', 'failure'],
        ['Step 3', 'skipped'],
        ['Step 4', 'success'],
      ]);
      expect(result.steps[2]?.error).toContain(message);
      const log = readFileSync(join(logDir, '02-set-up-mise.log'), 'utf8');
      expect(log.split('\n').filter((line) => line.startsWith(`Error: ${message}`))).toHaveLength(
        1,
      );
      // As on GitHub, the writes before the bad one and the GITHUB_PATH entries still count, and
      // the writes after it are lost.
      const later = h.tart.launcherFor(4);
      expect(later).toContain("'EARLIER=kept'");
      expect(later).toContain('/cfg/bin');
      expect(later).not.toContain('LATER=');
    },
  );

  test('an exported name A=B still gives later steps A, from its opening line, as the runner reads it', async () => {
    const h = harness({ environment: JSON.stringify({ 'A=B': 'v' }) });
    await h.run(requestOf({ later: [runStep(3, { when: 'always' })] }));
    expect(h.tart.launcherFor(3)).toMatch(/'A=B<<ghadelimiter_[\da-f-]{36}'/u);
  });

  test('an exported name with an empty part before =, such as =X, fails the step', async () => {
    const h = harness({ environment: JSON.stringify({ '=X': 'v' }) });
    const result = await h.run(requestOf());
    expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
    expect(outcomes(result)[2]).toEqual(['Set up mise', 'failure']);
  });

  test('continue-on-error covers a name GITHUB_ENV cannot carry, since the runner fails the step too', async () => {
    const h = harness({ environment: JSON.stringify({ 'A=B': 'v' }) });
    const result = await h.run(requestOf({ step: { continueOnError: true } }));
    expect(result.reason).toBe('passed');
  });

  test("a NODE_OPTIONS it exports is refused for later steps, as GitHub's runner refuses it", async () => {
    const h = harness({ environment: JSON.stringify({ FOO: 'bar', NODE_OPTIONS: '--inspect' }) });
    await h.run(requestOf());
    expect(h.tart.launcherFor(3)).toContain("'FOO=bar'");
    expect(h.tart.launcherFor(3)).not.toContain('NODE_OPTIONS');
    expect(readFileSync(join(logDir, '02-set-up-mise.log'), 'utf8')).toContain(
      "Error: Can't store NODE_OPTIONS output parameter using '$GITHUB_ENV' command.",
    );
  });

  test('a step its if: skips changes nothing, and later steps keep ignoring the config', async () => {
    const h = harness();
    const result = await h.run(requestOf({ step: { when: 'failure' } }));
    expect(outcomes(result)[2]).toEqual(['Set up mise', 'skipped']);
    expect(h.phases()).toEqual([]);
    const later = h.tart.launcherFor(3);
    expect(later).toContain(`'MISE_IGNORED_CONFIG_PATHS=${WORKSPACE}'`);
    expect(later).not.toContain('MISE_YES');
  });

  test("steps after it that ran, even failing, drop the runner's ignored config path; a workflow value stays", async () => {
    const h = harness({ exitCodes: { ls: 1 } });
    await h.run(requestOf({ later: [runStep(3, { when: 'always' })] }));
    expect(h.tart.launcherFor(3)).not.toContain('MISE_IGNORED_CONFIG_PATHS');
    const set = harness();
    await set.run(requestOf({ planEnv: { MISE_IGNORED_CONFIG_PATHS: '/plan' } }));
    expect(set.tart.launcherFor(3)).toContain("'MISE_IGNORED_CONFIG_PATHS=/plan'");
  });

  test('a failure partway keeps what it wrote before, for a later step that still runs', async () => {
    const h = harness({ environment: JSON.stringify({ FOO: 'bar' }), exitCodes: { ls: 1 } });
    const result = await h.run(requestOf({ later: [runStep(3), runStep(4, { when: 'always' })] }));
    expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
    expect(result.detail).toContain('step 2 "Set up mise"');
    expect(outcomes(result).slice(2)).toEqual([
      ['Set up mise', 'failure'],
      ['Step 3', 'skipped'],
      ['Step 4', 'success'],
    ]);
    const later = h.tart.launcherFor(4);
    expect(later).toContain("'MISE_YES=1'");
    expect(later).toContain(SHIMS);
    expect(later).not.toContain('FOO');
  });

  test("a mise --version that fails is ordinary, in the working directory after the writes of steps 1 to 4, as the action's own test of mise fails on GitHub", async () => {
    const h = harness({ exitCodes: { prepare: 3 } });
    const result = await h.run(
      requestOf({
        settings: { miseEnv: 'ci', workingDirectory: 'pkg' },
        step: { continueOnError: true },
      }),
    );
    expect(result.reason).toBe('passed');
    expect(result.steps[2]).toMatchObject({
      continuedOnError: true,
      error: 'mise exited with code 3',
      outcome: 'failure',
    });
    expect(h.phases()).toEqual(['probe', 'bins', 'prepare']);
    // The action's testMise sees the variables of steps 1 to 3 and the PATH of step 4.
    const prepare = h.script('prepare');
    expect(prepare).toContain(`cd '${WORKSPACE}/pkg'\nmise --version`);
    expect(prepare).toContain("'MISE_ENV=ci'");
    expect(prepare).toContain("'MISE_YES=1'");
    expect(prepare).toContain(`'MISE_TRUSTED_CONFIG_PATHS=${WORKSPACE}'`);
    expect(prepare).toContain(`export PATH="/wf/node:${SHIMS}:`);
    const later = h.tart.launcherFor(3);
    expect(later).toContain("'MISE_YES=1'");
    expect(later).toContain(`/wf/node:${SHIMS}`);
  });

  test("Hugi's own commands before the writes never run mise --version without version", async () => {
    const h = harness();
    await h.run(requestOf());
    expect(h.script('probe')).not.toContain('mise --version');
    expect(h.phases()).not.toContain('version');
  });

  test("with version, reads the guest's mise version in a call of its own, after the probe and before the writes", async () => {
    const h = harness();
    await h.run(requestOf({ settings: { miseEnv: 'ci', version: '2026.11.12' } }));
    expect(h.phases().slice(0, 3)).toEqual(['probe', 'version', 'bins']);
    const version = h.script('version');
    expect(version).toContain("cd '/Users/admin/hugi/temp'");
    expect(version).toContain('mise --version >');
    expect(version).toContain("'MISE_ENV=ci'");
    expect(version).toContain("'MISE_CEILING_PATHS=/Users/admin/hugi'");
    expect(version).not.toContain('MISE_YES');
  });

  test("a step PATH that does not reach the guest's mise is Hugi's own, though the action would add mise to PATH", async () => {
    const h = harness({ probe: probe({ onPath: false }) });
    const result = await h.run(
      requestOf({ step: { continueOnError: true, env: { PATH: '/usr/bin:/bin' } } }),
    );
    expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
    expect(result.detail).toContain("the step's PATH does not reach the guest's mise");
    expect(result.steps[2]).not.toHaveProperty('continuedOnError');
    expect(h.phases()).toEqual(['probe']);
    const script = h.script('probe');
    expect(script).toContain('export PATH="/usr/bin:/bin"');
    expect(script).toContain('command -v mise');
  });

  test('continue-on-error lets an ordinary failure pass, as on GitHub', async () => {
    const h = harness({ exitCodes: { install: 1 } });
    const result = await h.run(requestOf({ step: { continueOnError: true } }));
    expect(result.reason).toBe('passed');
    expect(result.steps[2]).toMatchObject({ continuedOnError: true, outcome: 'failure' });
    expect(outcomes(result)[3]).toEqual(['Step 3', 'success']);
  });

  test('a timeout-minutes that passes times the step out, and continue-on-error applies to it', async () => {
    const h = harness({ hangs: 'install' });
    const result = await h.run(
      requestOf({ later: [runStep(3, { when: 'always' })], step: { timeoutMinutes: 1 } }),
    );
    expect(result.reason).toBe('step-failed');
    expect(outcomes(result).slice(2)).toEqual([
      ['Set up mise', 'timeout'],
      ['Step 3', 'success'],
    ]);
    expect(h.phases()).not.toContain('overlap');
    const tolerated = harness({ hangs: 'install' });
    const passed = await tolerated.run(
      requestOf({ step: { continueOnError: true, timeoutMinutes: 1 } }),
    );
    expect(passed.reason).toBe('passed');
  });

  test.each<MiseActionPhase>([
    'probe',
    'version',
    'bins',
    'listing',
    'requests',
    'install-check',
    'overlap',
  ])(
    "a timeout-minutes that passes during Hugi's own %s fails the lane even under continue-on-error",
    async (phase) => {
      const h = harness({ hangs: phase });
      const result = await h.run(
        requestOf({
          settings: { version: '2026.11.12' },
          step: { continueOnError: true, timeoutMinutes: 1 },
        }),
      );
      expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
      expect(result.steps[2]).toMatchObject({ outcome: 'timeout' });
      expect(result.steps[2]).not.toHaveProperty('continuedOnError');
      expect(h.phases().at(-1)).toBe(phase);
    },
  );

  test.each<MiseActionPhase>(['prepare', 'install', 'ls', 'env'])(
    "a timeout-minutes that passes during the action's own %s is tolerated under continue-on-error",
    async (phase) => {
      const h = harness({ hangs: phase });
      const result = await h.run(requestOf({ step: { continueOnError: true, timeoutMinutes: 1 } }));
      expect(result.reason).toBe('passed');
      expect(result.steps[2]).toMatchObject({ continuedOnError: true, outcome: 'timeout' });
      expect(h.phases().at(-1)).toBe(phase);
    },
  );

  test('exports the PATH entries the overlap check inspected, from its one mise env --paths', async () => {
    const h = harness({ paths: '/cfg/bin\n' });
    await h.run(requestOf());
    expect(h.script('overlap')).toContain(
      "mise env --paths > '/Users/admin/hugi/control/step-02/mise-paths.txt'",
    );
    expect(h.script('env')).not.toContain('--paths');
    expect(h.tart.launcherFor(3)).toContain('export PATH="/cfg/bin:/wf/node:');
  });

  test.each(['pkg/app', "team's/pkg"])(
    'the fake lists every place the lock file search names, for a working directory %s',
    async (workingDirectory) => {
      const h = harness();
      const result = await h.run(requestOf({ settings: { workingDirectory } }));
      expect(result.reason).toBe('passed');
      expect(h.script('install')).toMatch(/^mise install$/m);
    },
  );

  test('runs mise ls in the working directory, as the action does', async () => {
    const h = harness();
    await h.run(requestOf({ settings: { workingDirectory: 'pkg' } }));
    expect(h.script('ls')).toMatch(new RegExp(`^cd '${WORKSPACE}/pkg'\\nmise ls$`, 'm'));
  });

  test('a matching version passes the check', async () => {
    const h = harness();
    expect((await h.run(requestOf({ settings: { version: '2026.11.12' } }))).reason).toBe('passed');
  });
});

describe("Hugi's own failures of a jdx/mise-action step fail the lane even under continue-on-error", () => {
  const pinnedNode = JSON.stringify({
    node: [
      { requested_version: '22', source: { path: `${WORKSPACE}/mise.toml`, type: 'mise.toml' } },
    ],
  });
  test.each<[string, FakeMiseAction, Partial<MiseActionSettings>, string[], string]>([
    ['a version mismatch', {}, { version: '2026.1.0' }, ['probe', 'version'], '2026.1.0'],
    [
      'a version the guest mise cannot report',
      { exitCodes: { version: 3 } },
      { version: '2026.11.12' },
      ['probe', 'version'],
      "reading the guest's mise version",
    ],
    [
      'a version Hugi cannot read',
      { version: '' },
      { version: '2026.11.12' },
      ['probe', 'version'],
      'mise --version printed no version',
    ],
    [
      "mise not on the step's PATH",
      { probe: probe({ onPath: false }) },
      {},
      ['probe'],
      "the step's PATH does not reach the guest's mise",
    ],
    [
      'a mise without the commands the step needs',
      { probe: probe({ supports: { envJson: true, envPaths: false, installLocked: true } }) },
      {},
      ['probe'],
      'mise env --paths',
    ],
    [
      "a probe command of Hugi's own that fails",
      { exitCodes: { probe: 127 }, probe: '' },
      {},
      ['probe'],
      "the probe of the guest's mise",
    ],
    [
      'workflow tools bins mise cannot find',
      { exitCodes: { bins: 1 } },
      {},
      ['probe', 'bins'],
      'mise bin-paths',
    ],
    [
      'fewer workflow tools bins than pinned tools',
      { workflowBins: '' },
      {},
      ['probe', 'bins'],
      '0 directories for 1 pinned workflow tools',
    ],
    [
      'a config listing that exits non-zero',
      { exitCodes: { listing: 1 } },
      {},
      ['probe', 'bins', 'prepare', 'listing'],
      'mise config ls exited with code 1',
    ],
    [
      'a config listing Hugi cannot read',
      { configListing: 'not json\n' },
      {},
      ['probe', 'bins', 'prepare', 'listing'],
      'listing',
    ],
    [
      'a mise ls --current that exits non-zero',
      { exitCodes: { requests: 1 } },
      {},
      ['probe', 'bins', 'prepare', 'listing', 'requests'],
      'mise ls --current exited with code 1',
    ],
    [
      'a mise ls --current Hugi cannot read',
      { configRequests: 'not json' },
      {},
      ['probe', 'bins', 'prepare', 'listing', 'requests'],
      'mise ls --current',
    ],
    [
      'a lock file search that exits non-zero',
      { exitCodes: { 'install-check': 1 } },
      {},
      ['probe', 'bins', 'prepare', 'listing', 'requests', 'install-check'],
      'the lock file search exited with code 1',
    ],
    [
      'a lock file search Hugi cannot read',
      { installCheck: 'not json\n' },
      {},
      ['probe', 'bins', 'prepare', 'listing', 'requests', 'install-check'],
      'the install check',
    ],
    ['a probe Hugi cannot read', { probe: 'not json' }, {}, ['probe'], 'the mise probe'],
    [
      'a loaded config file outside the workspace',
      { configListing: listing(`${WORKSPACE}/mise.toml`, '/Users/admin/.config/mise/config.toml') },
      {},
      ['probe', 'bins', 'prepare', 'listing'],
      '/Users/admin/.config/mise/config.toml',
    ],
    [
      'a config request that differs from a workflow pin',
      { configListing: listing(`${WORKSPACE}/mise.toml`), configRequests: pinnedNode },
      {},
      ['probe', 'bins', 'prepare', 'listing', 'requests'],
      'node: the workflow pins 22.23.2',
    ],
    [
      'a monorepo config',
      { installCheck: lines({ monorepo: true }) },
      {},
      ['probe', 'bins', 'prepare', 'listing', 'requests', 'install-check'],
      'monorepo',
    ],
    [
      'an executable on PATH from two installs',
      {
        exitCodes: { install: 1 },
        overlap: lines(
          listed('config', '/data/npm-pnpm/bin', ['pnpm']),
          listed('workflow', '/data/pnpm/bin', ['pnpm']),
        ),
      },
      {},
      ['probe', 'bins', 'prepare', 'listing', 'requests', 'install-check', 'install', 'overlap'],
      'pnpm',
    ],
    [
      'directories the overlap check cannot list',
      { exitCodes: { overlap: 1 } },
      {},
      ['probe', 'bins', 'prepare', 'listing', 'requests', 'install-check', 'install', 'overlap'],
      'overlap',
    ],
  ])('%s', async (_name, fake, settings, phases, detail) => {
    const h = harness(fake);
    const result = await h.run(requestOf({ settings, step: { continueOnError: true } }));
    expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
    expect(result.detail).toContain(detail);
    expect(result.steps[2]).not.toHaveProperty('continuedOnError');
    expect(outcomes(result)[3]).toEqual(['Step 3', 'skipped']);
    expect(h.phases()).toEqual(phases);
  });
});

test.each(['MISE_CONFIG_DIR', 'MISE_GLOBAL_CONFIG_FILE', 'MISE_CEILING_PATHS'])(
  "a step environment that sets %s, which Hugi's isolation replaces, fails the step as Hugi's own",
  async (name) => {
    const h = harness();
    const result = await h.run(
      requestOf({ step: { continueOnError: true, env: { [name]: '/repo/mise' } } }),
    );
    expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
    expect(result.detail).toContain(name);
    expect(result.steps[2]).not.toHaveProperty('continuedOnError');
    expect(h.phases()).toEqual([]);
  },
);

test.each(['SHELLOPTS', 'POSIXLY_CORRECT', 'POSIX_PEDANTIC', 'TMOUT', 'BASH_FUNC_mise%%'])(
  "a step environment that sets %s, which would change the bash of the step's mise commands, fails the step as Hugi's own before its first command",
  async (name) => {
    const h = harness();
    const result = await h.run(
      requestOf({ planEnv: { [name]: '1' }, step: { continueOnError: true } }),
    );
    expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
    expect(result.detail).toContain(`the step's environment sets ${name}, which would change`);
    expect(result.steps[2]).not.toHaveProperty('continuedOnError');
    expect(h.phases()).toEqual([]);
  },
);

test("a step environment's BASHOPTS, which the guest's bash 3.2 ignores, reaches the step's mise commands", async () => {
  const h = harness();
  const result = await h.run(requestOf({ step: { env: { BASHOPTS: 'nullglob' } } }));
  expect(result).toMatchObject({ verdict: 'pass' });
  expect(h.script('probe')).toContain("'BASHOPTS=nullglob'");
});

test("a step environment's BASH_ENV and ENV reach the step's mise commands as exports inside their bash, as on GitHub", async () => {
  const h = harness();
  const result = await h.run(
    requestOf({ step: { env: { BASH_ENV: '/repo/bash-env.sh', ENV: '/repo/env.sh' } } }),
  );
  expect(result.reason).toBe('passed');
  for (const phase of STEP_PHASES) {
    const script = h.tart.miseActionScript(2, phase);
    expect(script).toContain('-u BASH_ENV -u ENV');
    expect(script).not.toContain("'BASH_ENV=");
    expect(readableGuestScript(script)).toContain(
      "\nexport BASH_ENV='/repo/bash-env.sh'\nexport ENV='/repo/env.sh'\nmkdir -p ",
    );
  }
});

/** The scripts a run of the step with `settings`, `tools` and `step` generated, as the guest runs them. */
async function scriptsOf(
  settings: Partial<MiseActionSettings>,
  fake: FakeMiseAction = {},
  tools: string[] = [],
  step: Partial<ActionStep> = {},
) {
  const h = harness(fake);
  await h.run(requestOf({ settings, step, tools }));
  return (phase: MiseActionPhase) => h.tart.miseActionScript(2, phase);
}

const mise = Bun.which('mise');
const jq = Bun.which('jq');

/**
 * Why the real-shell suite cannot run on this host, if it cannot: mise or jq is missing, or the
 * host's mise lacks a flag the step needs, by the probe's own test of the help text.
 */
function realShellGap(): string | undefined {
  if (mise === null || jq === null) {
    return 'mise or jq is not on PATH';
  }
  const home = mkdtempSync(join(tmpdir(), 'hugi-mise-help-'));
  try {
    const missing = [
      ['env', '--json'],
      ['env', '--paths'],
      ['install', '--locked'],
    ].filter(([command = '', flag = '']) => {
      const help = Bun.spawnSync([mise, command, '--help'], {
        env: { HOME: home, NO_COLOR: '1', PATH: '/usr/bin:/bin' },
      });
      const text = `${help.stdout.toString()}${help.stderr.toString()}`;
      return !new RegExp(`(^|\\s)${flag}([\\s,]|$)`, 'mu').test(text);
    });
    return missing.length === 0
      ? undefined
      : `the host's mise lacks ${missing.map((words) => `mise ${words.join(' ')}`).join(', ')}`;
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
}
const gap = realShellGap();

describe.skipIf(gap !== undefined)(
  `the step's guest scripts, run on the host with real bash, jq and mise${gap === undefined ? '' : ` (skipped: ${gap})`}`,
  () => {
    let root = '';
    const hugi = () => join(root, 'hugi');
    const workspace = () => join(hugi(), 'workspace');

    beforeEach(() => {
      // Outside the checkout, so no config of this repository lies above the workspace.
      root = realpathSync(mkdtempSync(join(tmpdir(), 'hugi-mise-action-scripts-')));
      const ws = workspace();
      for (const dir of ['pkg/app', 'bin', '.config/mise', 'mono']) {
        mkdirSync(join(ws, dir), { recursive: true });
      }
      for (const dir of ['temp', 'control', 'wf/other', 'elsewhere']) {
        mkdirSync(join(hugi(), dir), { recursive: true });
      }
      mkdirSync(join(root, 'home/.config/mise'), { recursive: true });
      writeFileSync(join(ws, 'mise.toml'), '[env]\n_.path = ["bin", "missing"]\n');
      writeFileSync(join(ws, 'mono/mise.toml'), '[monorepo]\nconfig_roots = ["a"]\n');
      writeFileSync(join(ws, 'pkg/mise.lock'), '');
      writeFileSync(join(hugi(), 'elsewhere/mise.lock'), '');
      symlinkSync(join(hugi(), 'elsewhere/mise.lock'), join(ws, '.config/mise/config.lock'));
      writeFileSync(join(hugi(), 'mise.toml'), '[tools]\nbun = "1"\n');
      writeFileSync(join(hugi(), 'mise.lock'), '');
      writeFileSync(join(root, 'home/.config/mise/config.toml'), '[tools]\nnode = "22"\n');
      for (const dir of [join(ws, 'bin'), join(hugi(), 'wf/other')]) {
        writeFileSync(join(dir, 'node'), '#!/bin/sh\n');
        chmodSync(join(dir, 'node'), 0o755);
      }
      symlinkSync(join(ws, 'bin'), join(hugi(), 'wf/link'));
    });

    afterEach(() => {
      rmSync(root, { force: true, recursive: true });
    });

    /**
     * Run a captured guest script on the host, with the guest's directories moved under `root`
     * and the programs of `stubs` ahead of the directories of `programs`, by default mise's and
     * jq's; its exit code must be `exitCode`.
     */
    function onHost(
      script: string,
      { exitCode = 0, programs = [dirname(mise!), dirname(jq!)], stubs = '' } = {},
    ): void {
      const front = [stubs, ...programs, '/bin'].join(':');
      const text = script
        .replaceAll('/Users/admin/hugi', hugi())
        .replace('export PATH="', `export PATH="${front}:`);
      const ran = Bun.spawnSync(['bash', '-s'], {
        env: { HOME: join(root, 'home'), PATH: '/usr/bin:/bin' },
        stdin: new TextEncoder().encode(text),
      });
      expect(ran.exitCode, ran.stdout.toString()).toBe(exitCode);
    }

    /** A directory holding a `name` program that runs `body` (sh). */
    function stub(name: string, body: string): string {
      const dir = join(root, `stub-${name}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
      return dir;
    }

    const output = (name: string) => readFileSync(join(hugi(), 'control/step-02', name), 'utf8');

    test("the probe reports the guest's mise on PATH, its data directory and its capabilities", async () => {
      onHost((await scriptsOf({}))('probe'));
      expect(parseProbe(output('mise-probe.json'))).toEqual({
        dataDir: join(root, 'home/.local/share/mise'),
        onPath: true,
        supports: { envJson: true, envPaths: true, installLocked: true },
      });
    });

    test("a step PATH without the guest's mise fails the lane under continue-on-error", async () => {
      const step = { continueOnError: true, env: { PATH: '/usr/bin:/bin' } };
      const script = (await scriptsOf({}, {}, [], step))('probe');
      // Only jq, through a program of its own, joins the step's PATH: mise stays off it.
      onHost(script, { programs: [], stubs: stub('jq', `exec ${jq!} "$@"`) });
      const found = output('mise-probe.json');
      expect(parseProbe(found).onPath).toBe(false);
      const h = harness({ probe: found.replaceAll(hugi(), '/Users/admin/hugi') });
      const result = await h.run(requestOf({ step }));
      expect(result).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
      expect(result.detail).toContain("the step's PATH does not reach the guest's mise");
    });

    test("the version call reads the guest's mise version", async () => {
      onHost((await scriptsOf({ version: '1' }))('version'));
      const version = Bun.spawnSync([mise!, '--version']).stdout.toString().split(/\s+/)[0];
      expect(miseVersion(output('mise-version.txt'))).toBe(version!.replace(/^v/, ''));
    });

    test('the listing loads only the workspace config, not the one above it or the global one', async () => {
      onHost((await scriptsOf({ workingDirectory: 'pkg/app' }))('listing'));
      const loaded = parseConfigListing(output('mise-config-listing.txt'));
      expect(loaded.workspace).toBe(workspace());
      expect(loaded.files.map((file) => file.path)).toEqual([join(workspace(), 'mise.toml')]);
    });

    test('the lock file search lists regular files up to the workspace root, not a symbolic link', async () => {
      onHost((await scriptsOf({ workingDirectory: 'pkg/app' }))('install-check'));
      const found = output('mise-install.txt');
      const places = lockFilePlaces('pkg/app').map(({ path, patterns }) => ({
        path: path.replace('/Users/admin/hugi', hugi()),
        patterns,
      }));
      expect(hasLockFile(places, found)).toBe(true);
      expect(found).not.toContain('config.lock');
      expect(found).not.toContain(`"${hugi()}"`);
      expect(setsMonorepoRoots(found)).toBe(false);
    });

    test.each([
      ['.config', '.mise.lock'],
      ['mise', 'config.lock'],
      ['.mise', 'config.lock'],
      ['.config/mise', 'config.ci.lock'],
    ])(
      'a working directory %s, which the workspace search shares, holding %s installs with --locked',
      async (directory, file) => {
        mkdirSync(join(workspace(), directory), { recursive: true });
        writeFileSync(join(workspace(), directory, file), '');
        onHost((await scriptsOf({ workingDirectory: directory }))('install-check'));
        const found = output('mise-install.txt').replaceAll(hugi(), '/Users/admin/hugi');
        const h = harness({ installCheck: found });
        await h.run(requestOf({ settings: { workingDirectory: directory } }));
        expect(h.script('install')).toMatch(/^mise install --locked$/m);
      },
    );

    test('the install check finds monorepo.config_roots', async () => {
      onHost((await scriptsOf({ workingDirectory: 'mono' }))('install-check'));
      expect(setsMonorepoRoots(output('mise-install.txt'))).toBe(true);
    });

    test('the overlap listing resolves links, so the same directory passes and another one fails', async () => {
      const workflowBins = '/Users/admin/hugi/wf/link\n/Users/admin/hugi/wf/other\n';
      onHost((await scriptsOf({}, { workflowBins }, ['node@22', 'bun@1']))('overlap'));
      const conflicts = overlapConflicts(output('mise-overlap.txt'));
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toStartWith('node: ');
      expect(conflicts[0]).toContain(join(workspace(), 'bin'));
      expect(conflicts[0]).toContain(join(hugi(), 'wf/other'));
    });

    test('the overlap listing inspects the PATH entries it captures for the export', async () => {
      onHost((await scriptsOf({}, {}, ['node@22']))('overlap'));
      const inspected = [
        ...output('mise-overlap.txt').matchAll(/^\{"role":"config","dir":"([^"]*)"/gmu),
      ].map(([, dir]) => dir);
      expect(inspected).toContain(join(workspace(), 'bin'));
      expect(inspected).toEqual(managedPaths(output('mise-paths.txt')));
    });

    test('a file named like a jq option does not break the lock file search', async () => {
      mkdirSync(join(workspace(), 'solo'));
      writeFileSync(join(workspace(), 'solo/-notes'), '');
      const installed = async () => {
        onHost((await scriptsOf({ workingDirectory: 'solo' }))('install-check'));
        const h = harness({
          installCheck: output('mise-install.txt').replaceAll(hugi(), '/Users/admin/hugi'),
        });
        await h.run(requestOf({ settings: { workingDirectory: 'solo' } }));
        return h.script('install');
      };
      expect(await installed()).toMatch(/^mise install$/m);
      expect(output('mise-install.txt')).toContain('"-notes"');
      writeFileSync(join(workspace(), 'solo/mise.lock'), '');
      expect(await installed()).toMatch(/^mise install --locked$/m);
    });

    test('an executable named like a jq option does not break the overlap check', async () => {
      for (const dir of [join(workspace(), 'bin'), join(hugi(), 'wf/other')]) {
        writeFileSync(join(dir, '-status'), '#!/bin/sh\n');
        chmodSync(join(dir, '-status'), 0o755);
      }
      const workflowBins = '/Users/admin/hugi/wf/other\n';
      onHost((await scriptsOf({}, { workflowBins }, ['node@22']))('overlap'));
      const conflicts = overlapConflicts(output('mise-overlap.txt'));
      expect(conflicts.map((conflict) => conflict.split(':')[0])).toEqual(['-status', 'node']);
    });
  },
);
