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
import { advanceUntilSettled, FAKE_MISE_PROBE, FakeClock, FakeTart } from './fake-tart';
import type { FakeGuest, FakeMiseAction, MiseActionPhase } from './fake-tart';
import { runInVm } from './lifecycle';
import {
  hasLockFile,
  lockFilePlaces,
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
  const script = (phase: MiseActionPhase) => tart.miseActionScript(2, phase);
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
    expect(later).toContain(`export MISE_TRUSTED_CONFIG_PATHS='${WORKSPACE}'`);
    expect(later).toContain("export MISE_YES='1'");
    expect(later).toContain("export MISE_LOG_LEVEL='info'");
    expect(later).toContain("export FOO='bar'");
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
      expect(script).toContain("export MISE_CEILING_PATHS='/Users/admin/hugi'");
      expect(script).toContain(
        "export MISE_CONFIG_DIR='/Users/admin/hugi/control/step-02/mise-config'",
      );
      expect(script).toContain(
        "export MISE_GLOBAL_CONFIG_FILE='/Users/admin/hugi/control/step-02/mise-config/config.toml'",
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
    expect(bins).toContain("export MISE_NODE_VERSION='22.23.2'");
    for (const name of ['MISE_DATA_DIR', 'XDG_DATA_HOME', 'HOME', 'MISE_CONFIG_DIR']) {
      expect(bins).not.toContain(`export ${name}=`);
    }
    // The shims directory still follows the step's environment, by the action's rule.
    expect(h.script('probe')).toContain("export MISE_DATA_DIR='/plan/mise'");
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
    expect(h.script('probe')).toContain("export MISE_IGNORED_CONFIG_PATHS='/plan'");
    expect(h.script('probe')).toContain("export MISE_NODE_VERSION='20'");
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
    expect(prepare).toContain("export MISE_EXPERIMENTAL='1'");
    expect(prepare).toContain("export MISE_YES='1'");
    expect(prepare).toContain("export MISE_LOG_LEVEL='warn'");
    const later = h.tart.launcherFor(3);
    expect(later).toContain("export MISE_YES='1'");
    expect(later).not.toContain('MISE_LOG_LEVEL');
  });

  test('writes mise_env first, over any value, so its first mise command sees it', async () => {
    const h = harness();
    await h.run(requestOf({ settings: { miseEnv: 'ci' }, step: { env: { MISE_ENV: 'dev' } } }));
    expect(h.script('probe')).toContain("export MISE_ENV='ci'");
    expect(h.tart.launcherFor(3)).toContain("export MISE_ENV='ci'");
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
    expect(later).toContain("export MISE_ENV='ci'");
    expect(later).toContain("export MISE_YES='1'");
    expect(later).toContain(SHIMS);
  });

  test('installs with --locked when a lock file lies between the working directory and the workspace root', async () => {
    const h = harness({
      installCheck: lines({ files: ['mise.toml', 'mise.lock'], path: `${WORKSPACE}/pkg` }),
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

  test('lists the config directories and the workflow tools bins for the overlap check', async () => {
    const h = harness();
    await h.run(requestOf());
    const overlap = h.script('overlap');
    expect(overlap).toContain('mise env --paths');
    expect(overlap).toContain('realpath');
    expect(overlap).toContain("'/wf/node'");
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

  test("a NODE_OPTIONS it exports is refused for later steps, as GitHub's runner refuses it", async () => {
    const h = harness({ environment: JSON.stringify({ FOO: 'bar', NODE_OPTIONS: '--inspect' }) });
    await h.run(requestOf());
    expect(h.tart.launcherFor(3)).toContain("export FOO='bar'");
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
    expect(later).toContain(`export MISE_IGNORED_CONFIG_PATHS='${WORKSPACE}'`);
    expect(later).not.toContain('MISE_YES');
  });

  test("steps after it that ran, even failing, drop the runner's ignored config path; a workflow value stays", async () => {
    const h = harness({ exitCodes: { ls: 1 } });
    await h.run(requestOf({ later: [runStep(3, { when: 'always' })] }));
    expect(h.tart.launcherFor(3)).not.toContain('MISE_IGNORED_CONFIG_PATHS');
    const set = harness();
    await set.run(requestOf({ planEnv: { MISE_IGNORED_CONFIG_PATHS: '/plan' } }));
    expect(set.tart.launcherFor(3)).toContain("export MISE_IGNORED_CONFIG_PATHS='/plan'");
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
    expect(later).toContain("export MISE_YES='1'");
    expect(later).toContain(SHIMS);
    expect(later).not.toContain('FOO');
  });

  test("a mise --version that fails is ordinary, as the action's own test of mise fails on GitHub", async () => {
    const h = harness({ exitCodes: { probe: 3 }, probe: '' });
    const result = await h.run(requestOf({ step: { continueOnError: true } }));
    expect(result.reason).toBe('passed');
    expect(result.steps[2]).toMatchObject({
      continuedOnError: true,
      error: 'mise --version exited with code 3',
      outcome: 'failure',
    });
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
    ['a version mismatch', {}, { version: '2026.1.0' }, ['probe'], '2026.1.0'],
    [
      'a mise without the commands the step needs',
      { probe: probe({ supports: { envJson: true, envPaths: false, installLocked: true } }) },
      {},
      ['probe'],
      'mise env --paths',
    ],
    [
      "a probe command of Hugi's own that fails after mise --version",
      { exitCodes: { probe: 1 } },
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
    [
      'a probe Hugi cannot read',
      { probe: 'not json' },
      {},
      ['probe'],
      'the mise probe',
    ],
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
    [
      'a variable a later step cannot export',
      { environment: JSON.stringify({ 'A-B': 'x' }) },
      {},
      ALL_PHASES,
      '"A-B"',
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

/** The scripts a run of the step with `settings` and no workflow tools generated. */
async function scriptsOf(
  settings: Partial<MiseActionSettings>,
  fake: FakeMiseAction = {},
  tools: string[] = [],
) {
  const h = harness(fake);
  await h.run(requestOf({ settings, tools }));
  return h.script;
}

const mise = Bun.which('mise');
const jq = Bun.which('jq');

describe.skipIf(mise === null || jq === null)(
  "the step's guest scripts, run on the host with real bash, jq and mise",
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
     * and the programs of `stubs` ahead of the real ones; its exit code must be `exitCode`.
     */
    function onHost(script: string, { exitCode = 0, stubs = '' } = {}): void {
      const text = script
        .replaceAll('/Users/admin/hugi', hugi())
        .replace('export PATH="', `export PATH="${stubs}:${dirname(mise!)}:${dirname(jq!)}:/bin:`);
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

    test("the probe reports the guest's mise, its data directory and its capabilities", async () => {
      onHost((await scriptsOf({}))('probe'));
      const probed = parseProbe(output('mise-probe.json'));
      const version = Bun.spawnSync([mise!, '--version']).stdout.toString().split(/\s+/)[0];
      expect(probed).toEqual({
        dataDir: join(root, 'home/.local/share/mise'),
        supports: { envJson: true, envPaths: true, installLocked: true },
        version: version!.replace(/^v/, ''),
      });
    });

    test('the probe file stays empty only when mise --version itself fails', async () => {
      const script = (await scriptsOf({}))('probe');
      onHost(script, { exitCode: 3, stubs: stub('mise', 'exit 3') });
      expect(output('mise-probe.json')).toBe('');
      onHost(script, { exitCode: 4, stubs: stub('jq', 'exit 4') });
      expect(output('mise-probe.json')).not.toBe('');
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
  },
);
