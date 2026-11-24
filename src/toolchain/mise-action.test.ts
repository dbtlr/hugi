import { expect, test } from 'bun:test';

import type { ActionStep, StepPlan } from '../lane/step-plan';
import { resolveToolchains, UnsupportedActionError } from './resolver';
import type { ActionResolution } from './resolver';

const SHA = 'a'.repeat(40);

function miseAction(inputs: Record<string, string> = {}, ref = 'v5'): ActionStep {
  return {
    continueOnError: false,
    env: {},
    index: 2,
    kind: 'action',
    name: 'Set up mise',
    uses: `jdx/mise-action@${ref}`,
    when: 'success',
    with: inputs,
  };
}

function plan(...steps: StepPlan['steps']): StepPlan {
  return {
    env: {},
    lane: { job: 'test', matrix: {}, workflow: '.github/workflows/ci.yml' },
    name: 'test',
    steps,
    timeoutMinutes: 30,
  };
}

const readNothing = async (_path: string): Promise<string | undefined> => undefined;

async function resolved(inputs: Record<string, string> = {}, ref = 'v5') {
  const result = await resolveToolchains(plan(miseAction(inputs, ref)), readNothing);
  const [action] = result.actions;
  if (action?.kind !== 'mise-action') {
    throw new Error(`expected a mise-action resolution, got ${JSON.stringify(action)}`);
  }
  return { action, result };
}

async function refusal(inputs: Record<string, string>, ref = 'v5'): Promise<string> {
  try {
    await resolveToolchains(plan(miseAction(inputs, ref)), readNothing);
  } catch (error) {
    if (!(error instanceof UnsupportedActionError)) {
      throw error;
    }
    return error.message;
  }
  throw new Error('expected resolution to fail');
}

const DEFAULTS: Extract<ActionResolution, { kind: 'mise-action' }>['settings'] = {
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

test('the action resolves to its settings, with the defaults of v5.3.0, and contributes no workflow tools', async () => {
  const { action, result } = await resolved();
  expect(action).toEqual({
    index: 2,
    kind: 'mise-action',
    name: 'Set up mise',
    settings: DEFAULTS,
    uses: 'jdx/mise-action@v5',
  });
  expect(result.tools).toEqual([]);
});

test('a workflow tool beside the action still resolves, and the action adds none', async () => {
  const setupNode: ActionStep = {
    ...miseAction(),
    index: 1,
    name: 'node',
    uses: 'actions/setup-node@v6',
    with: { 'node-version': '22.23.2' },
  };
  const result = await resolveToolchains(plan(setupNode, miseAction()), readNothing);
  expect(result.tools).toEqual(['node@22.23.2']);
  expect(result.actions.map((action) => action.kind)).toEqual(['tools', 'mise-action']);
});

test.each(['v5', 'v5.3.0', 'v5.3.12', 'v5.4.0', 'v5.10.1', SHA, 'A'.repeat(40)])(
  'the ref %s runs',
  async (ref) => {
    const { action } = await resolved({}, ref);
    expect(action.uses).toBe(`jdx/mise-action@${ref}`);
  },
);

test.each([
  'v4',
  'v3.6.1',
  'v5.2.9',
  'v5.0.0',
  'v5.3',
  'v5.03.0',
  'v5.3.0-rc.1',
  'V5',
  'v6',
  'main',
  'a'.repeat(39),
  `${SHA}0`,
])('the ref %s fails resolution', async (ref) => {
  expect(await refusal({}, ref)).toContain(`unsupported ref "${ref}"`);
});

test.each([
  ['install', 'install'],
  ['env', 'env'],
  ['export_path', 'exportPath'],
  ['add_shims_to_path', 'addShimsToPath'],
  ['reshim', 'reshim'],
  ['experimental', 'experimental'],
  ['monorepo', 'monorepo'],
] as const)('the boolean %s is honoured in every spelling GitHub accepts', async (input, key) => {
  for (const [value, expected] of [
    ['true', true],
    ['True', true],
    ['TRUE', true],
    ['false', false],
    ['False', false],
    ['FALSE', false],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one spelling at a time
    const { action } = await resolved({ [input]: value });
    expect(action.settings[key]).toBe(expected);
  }
});

test.each(['yes', '1', 'on', 'tRue', ''])(
  'a boolean value %j fails resolution, even for an input the action reads only sometimes',
  async (value) => {
    expect(await refusal({ install: value })).toContain('install must be true or false');
    expect(await refusal({ cache_save_post: value })).toContain(
      'cache_save_post must be true or false',
    );
  },
);

test('install_args becomes the tool names to install', async () => {
  const { action } = await resolved({ install_args: '  nushell  npm:pnpm aqua:cli/cli ' });
  expect(action.settings.installArgs).toEqual(['nushell', 'npm:pnpm', 'aqua:cli/cli']);
});

test.each(['node@22', '--locked', 'nushell -v', 'bun --dry-run'])(
  'install_args %j with a version or a flag fails resolution',
  async (value) => {
    expect(await refusal({ install_args: value })).toContain('install_args');
  },
);

// The action splits `mise install <args>` with @actions/exec's argStringToArray, which splits on
// spaces only and strips double quotes, so any other separator or a double quote would split
// differently. A single quote or a backslash it keeps is refused since no tool name contains one.
test.each(['nushell\tpnpm', 'nushell\npnpm', '"nushell"', "'nushell'", String.raw`nu\shell`])(
  'install_args %j, which the action would split differently, fails resolution',
  async (value) => {
    expect(await refusal({ install_args: value })).toContain('separated by spaces');
  },
);

test.each([
  ['sub', 'sub'],
  ['./sub/dir/', 'sub/dir'],
  ['a/./b', 'a/b'],
])('working_directory %j is honoured as %j', async (value, expected) => {
  const { action } = await resolved({ working_directory: value });
  expect(action.settings.workingDirectory).toBe(expected);
});

test.each(['.', './', ''])('working_directory %j is the workspace itself', async (value) => {
  const { action } = await resolved({ working_directory: value });
  expect(action.settings.workingDirectory).toBeUndefined();
});

test.each(['/abs', '../up', 'a/../b', String.raw`a\b`])(
  'working_directory %j outside the workspace fails resolution',
  async (value) => {
    expect(await refusal({ working_directory: value })).toContain('working_directory');
  },
);

test('log_level and mise_env are honoured, and an empty log_level exports none', async () => {
  const { action } = await resolved({ log_level: 'debug', mise_env: 'ci,macos' });
  expect(action.settings).toMatchObject({ logLevel: 'debug', miseEnv: 'ci,macos' });
  const empty = await resolved({ log_level: '', mise_env: '' });
  expect(empty.action.settings.logLevel).toBeUndefined();
  expect(empty.action.settings.miseEnv).toBeUndefined();
});

test.each([
  ['v2026.11.12', '2026.11.12'],
  ['2026.11.12', '2026.11.12'],
])('version %j is checked as %j', async (value, expected) => {
  const { action } = await resolved({ version: value });
  expect(action.settings.version).toBe(expected);
});

test('the cache, release-age, retry and download inputs are no-ops that leave the settings alone', async () => {
  const { action } = await resolved({
    auto_update: 'true',
    cache: 'false',
    cache_key: 'mise-{{platform}}',
    cache_key_prefix: 'mise-v2',
    cache_max_age_days: '0',
    cache_restore_retry_budget: '60s',
    cache_save: 'False',
    cache_save_post: 'TRUE',
    cache_save_retry_budget: '1.5m',
    fetch_from_github: 'false',
    minimum_release_age: '1d12h',
  });
  expect(action.settings).toEqual(DEFAULTS);
});

test.each(['0', '30', ' 7 ', ''])(
  'cache_max_age_days %j is accepted, as the action accepts it',
  async (value) => {
    await resolved({ cache_max_age_days: value });
  },
);

test.each(['-1', '1.5', 'thirty', 'Infinity'])(
  'cache_max_age_days %j fails resolution, as it fails the action',
  async (value) => {
    expect(await refusal({ cache_max_age_days: value })).toContain('cache_max_age_days');
  },
);

test.each(['0s', '60s', '500ms', '2m', '1h', '90', '1.5h', '2 M', ''])(
  'a retry budget %j is a duration the action accepts',
  async (value) => {
    await resolved({ cache_restore_retry_budget: value, cache_save_retry_budget: value });
  },
);

test.each(['1d', '-1s', '1m30s', 'soon'])(
  'a retry budget %j fails resolution, as the action fails before it runs',
  async (value) => {
    expect(await refusal({ cache_restore_retry_budget: value })).toContain(
      'cache_restore_retry_budget',
    );
    expect(await refusal({ cache_save_retry_budget: value })).toContain('cache_save_retry_budget');
  },
);

test.each(['24h', '1d12h', '6mo', '1y', '2w', '30m', '45s', '0s', '86400', '0'])(
  'minimum_release_age %j is a relative duration Hugi accepts',
  async (value) => {
    await resolved({ minimum_release_age: value });
  },
);

test.each(['2026-01-01', '2026-01-01T00:00:00Z', '1.5h', '24 h', '1ms', '5us', 'h', '', 'soon'])(
  'minimum_release_age %j fails resolution',
  async (value) => {
    expect(await refusal({ minimum_release_age: value })).toContain('minimum_release_age');
  },
);

test.each([
  'mise_toml',
  'tool_versions',
  'mise_dir',
  'install_dir',
  'plugins',
  'bootstrap_skip',
  'bootstrap_args',
  'sha256',
])('%s is refused unless empty', async (input) => {
  await resolved({ [input]: '' });
  await resolved({ [input]: '  ' });
  expect(await refusal({ [input]: 'x' })).toContain(input);
});

test.each(['bootstrap', 'wings_enabled'])('%s is refused unless false', async (input) => {
  for (const value of ['false', 'False', 'FALSE']) {
    // oxlint-disable-next-line no-await-in-loop -- one spelling at a time
    await resolved({ [input]: value });
  }
  expect(await refusal({ [input]: 'true' })).toContain(input);
  expect(await refusal({ [input]: 'no' })).toContain(input);
});

test('github_token is refused whenever it is set, and persist_github_token unless false', async () => {
  expect(await refusal({ github_token: 'ghp_x' })).toContain('github_token');
  expect(await refusal({ github_token: '' })).toContain('github_token');
  await resolved({ persist_github_token: 'false' });
  expect(await refusal({ persist_github_token: 'true' })).toContain('persist_github_token');
  expect(await refusal({ persist_github_token: 'ghp_x' })).toContain('persist_github_token');
});

test('an input v5.3.0 does not have fails resolution', async () => {
  expect(await refusal({ 'node-version': '22' })).toContain('unsupported input "node-version"');
});

test('a refusal names the step and the action reference', async () => {
  expect(await refusal({ plugins: 'yarn' })).toStartWith(
    'step 2 "Set up mise" (jdx/mise-action@v5): ',
  );
});
