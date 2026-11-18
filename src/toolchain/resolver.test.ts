import { expect, test } from 'bun:test';

import type { ActionStep, StepPlan } from '../lane/step-plan';
import { resolveToolchains, ToolchainResolutionError, UnsupportedActionError } from './resolver';

function action(uses: string, inputs: Record<string, string> = {}, index = 1): ActionStep {
  return {
    continueOnError: false,
    env: {},
    index,
    kind: 'action',
    name: `Set up tools ${index}`,
    uses,
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

async function readNothing(_path: string): Promise<string | undefined> {
  return undefined;
}

async function expectFailure(resolution: Promise<unknown>) {
  try {
    await resolution;
  } catch (cause) {
    return expect(() => {
      throw cause;
    });
  }
  throw new Error('Expected toolchain resolution to fail');
}

test('an unknown action fails the whole lane with the step and action in its typed error', async () => {
  const resolution = resolveToolchains(plan(action('unknown/setup-tool@v1', {}, 4)), readNothing);
  (await expectFailure(resolution)).toThrow(UnsupportedActionError);
  (await expectFailure(resolution)).toThrow(
    'step 4 "Set up tools 4" (unknown/setup-tool@v1): unsupported action',
  );
});

test('a known action rejects an unknown input instead of silently ignoring it', async () => {
  const resolution = resolveToolchains(
    plan(action('actions/checkout@v7', { 'fetch-depth': '0' })),
    readNothing,
  );
  (await expectFailure(resolution)).toThrow(UnsupportedActionError);
  (await expectFailure(resolution)).toThrow(
    'step 1 "Set up tools 1" (actions/checkout@v7): unsupported input "fetch-depth"',
  );
});

test.each(['latest', 'lts/*', 'x', '22.x', '^22.1.0', '~22', '>=22', '22 || 24', '22 24', ''])(
  'an unpinned Node version %j fails resolution',
  async (version) => {
    const resolution = resolveToolchains(
      plan(action('actions/setup-node@v7', { 'node-version': version })),
      readNothing,
    );
    (await expectFailure(resolution)).toThrow(UnsupportedActionError);
    (await expectFailure(resolution)).toThrow('unpinned node version');
  },
);

test.each(['22-nightly', '22-rc', '1.2-canary', '1.2.0-rc+build.1'])(
  'a prerelease alias without a build digit %j fails with the step and action',
  async (version) => {
    const resolution = resolveToolchains(
      plan(action('actions/setup-node@v7', { 'node-version': version }, 4)),
      readNothing,
    );
    (await expectFailure(resolution)).toThrow(UnsupportedActionError);
    (await expectFailure(resolution)).toThrow(
      `step 4 "Set up tools 4" (actions/setup-node@v7): unpinned node version "${version}"`,
    );
  },
);

test.each(['1.2.0-rc.1', '22-rc1', '1.2-canary.20261118', 'v1.2.0-rc.1+build.sha', '22+build.1'])(
  'a numeric version with a specific prerelease build or build metadata %j passes through',
  async (version) => {
    const result = await resolveToolchains(
      plan(action('actions/setup-node@v7', { 'node-version': version })),
      readNothing,
    );
    expect(result.tools).toEqual([`node@${version}`]);
  },
);

test('conflicting pins fail with both versions and their source steps', async () => {
  const resolution = resolveToolchains(
    plan(
      action('actions/setup-node@v7', { 'node-version': '22' }),
      action('actions/setup-node@v7', { 'node-version': '24' }, 5),
    ),
    readNothing,
  );
  (await expectFailure(resolution)).toThrow(ToolchainResolutionError);
  (await expectFailure(resolution)).toThrow(
    'step 5 "Set up tools 5" (actions/setup-node@v7): conflicting node pins: node@22 from step 1 "Set up tools 1" (actions/setup-node@v7), node@24',
  );
});

test('a numeric partial pin passes through unchanged and repeated pins install once', async () => {
  const result = await resolveToolchains(
    plan(
      action('actions/setup-node@v7', { 'node-version': '22' }),
      action('actions/setup-node@v7', { 'node-version': '22' }, 2),
    ),
    readNothing,
  );
  expect(result.tools).toEqual(['node@22']);
  expect(result.actions).toMatchObject([
    { index: 1, kind: 'tools', tools: ['node@22'] },
    { index: 2, kind: 'tools', tools: ['node@22'] },
  ]);
});

test('pnpm with neither a version nor packageManager fails the lane', async () => {
  const resolution = resolveToolchains(plan(action('pnpm/action-setup@v6')), readNothing);
  (await expectFailure(resolution)).toThrow(UnsupportedActionError);
  (await expectFailure(resolution)).toThrow('pnpm needs version or package.json packageManager');
});

test('a docker action reaching the resolver fails even after a supported action', async () => {
  const resolution = resolveToolchains(
    plan(
      action('actions/setup-node@v7', { 'node-version': '22' }),
      action('docker://alpine:3', {}, 2),
    ),
    readNothing,
  );
  (await expectFailure(resolution)).toThrow(UnsupportedActionError);
  (await expectFailure(resolution)).toThrow(
    'step 2 "Set up tools 2" (docker://alpine:3): unsupported action',
  );
});

test.each<{ inputs: Record<string, string>; manifest: string | undefined }>([
  { inputs: { version: '12.16.1' }, manifest: undefined },
  { inputs: {}, manifest: '{"packageManager":"pnpm@12.16.1"}' },
  { inputs: {}, manifest: '{"packageManager":"pnpm@12.16.1+sha512.abcdef1234"}' },
  { inputs: { version: '12.16.1' }, manifest: '{}' },
  { inputs: { version: '12.16.1' }, manifest: '{"packageManager":"pnpm@12.16.1"}' },
  {
    inputs: { version: '12.16.1' },
    manifest: '{"packageManager":"pnpm@12.16.1+sha512.abcdef1234"}',
  },
])(
  'pnpm resolves an explicit version or the packageManager pin: %j',
  async ({ inputs, manifest }) => {
    const result = await resolveToolchains(
      plan(action('pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413', inputs)),
      async (path) => (path === 'package.json' ? manifest : undefined),
    );
    expect(result.tools).toEqual(['pnpm@12.16.1']);
  },
);

test.each(['pnpm@10.0.0', 'pnpm@10.0.0+sha512.abcdef1234'])(
  'pnpm rejects conflicting version and packageManager pins: %s',
  async (packageManager) => {
    const resolution = resolveToolchains(
      plan(action('pnpm/action-setup@v6', { version: '12.16.1' }, 4)),
      async (path) => (path === 'package.json' ? JSON.stringify({ packageManager }) : undefined),
    );
    (await expectFailure(resolution)).toThrow(UnsupportedActionError);
    (await expectFailure(resolution)).toThrow(
      'step 4 "Set up tools 4" (pnpm/action-setup@v6): Multiple versions of pnpm specified',
    );
    (await expectFailure(resolution)).toThrow('12.16.1');
    (await expectFailure(resolution)).toThrow('10.0.0');
  },
);

test.each(['Error', 'bogus'])(
  'upload-artifact rejects an if-no-files-found value GitHub does not recognize: %s',
  async (value) => {
    const resolution = resolveToolchains(
      plan(action('actions/upload-artifact@v7', { 'if-no-files-found': value, path: 'dist' })),
      readNothing,
    );
    (await expectFailure(resolution)).toThrow(UnsupportedActionError);
    (await expectFailure(resolution)).toThrow(`if-no-files-found "${value}"`);
  },
);

test('pnpm without a version input prefers devEngines.packageManager, as the action does', async () => {
  const manifest = JSON.stringify({
    devEngines: { packageManager: { name: 'pnpm', version: '12.16.2' } },
    packageManager: 'pnpm@12.16.1',
  });
  const result = await resolveToolchains(plan(action('pnpm/action-setup@v6')), async (path) =>
    path === 'package.json' ? manifest : undefined,
  );
  expect(result.tools).toEqual(['pnpm@12.16.2']);
});

test('pnpm with a devEngines range fails as unpinned', async () => {
  const manifest = JSON.stringify({
    devEngines: { packageManager: { name: 'pnpm', version: '^12' } },
    packageManager: 'pnpm@12.16.1',
  });
  const resolution = resolveToolchains(plan(action('pnpm/action-setup@v6')), async (path) =>
    path === 'package.json' ? manifest : undefined,
  );
  (await expectFailure(resolution)).toThrow(UnsupportedActionError);
});

test.each<{ contents: string | undefined; inputs: Record<string, string> }>([
  { contents: undefined, inputs: { 'bun-version': '1.4.4' } },
  { contents: 'nodejs 22.23.2\nbun 1.4.4\n', inputs: { 'bun-version-file': '.tool-versions' } },
])('Bun resolves its explicit or tool-versions pin: %j', async ({ inputs, contents }) => {
  const result = await resolveToolchains(
    plan(action('oven-sh/setup-bun@v2', inputs)),
    async (path) => (path === '.tool-versions' ? contents : undefined),
  );
  expect(result.tools).toEqual(['bun@1.4.4']);
});

test('artifact upload with if-no-files-found: error resolves as a no-op noting the skipped existence check', async () => {
  const result = await resolveToolchains(
    plan(
      action('actions/setup-node@v7', { 'node-version': '22' }),
      action(
        'actions/upload-artifact@v7',
        { 'if-no-files-found': 'error', path: 'dist/binary' },
        3,
      ),
    ),
    readNothing,
  );
  expect(result.tools).toEqual(['node@22']);
  expect(result.actions).toMatchObject([
    { kind: 'tools', tools: ['node@22'] },
    {
      index: 3,
      kind: 'noop',
      reason:
        'Verification only: Hugi publishes no artifacts (ADR-0002). Artifact path existence check is skipped.',
    },
  ]);
});

test.each([undefined, 'warn', 'ignore'])(
  'artifact upload with if-no-files-found: %j remains a documented no-op',
  async (value) => {
    const inputs: Record<string, string> = { name: 'binary', path: 'dist/binary' };
    if (value !== undefined) {
      inputs['if-no-files-found'] = value;
    }
    const result = await resolveToolchains(
      plan(action('actions/upload-artifact@v7', inputs)),
      readNothing,
    );
    expect(result.tools).toEqual([]);
    expect(result.actions).toMatchObject([
      { kind: 'noop', reason: 'Verification only: Hugi publishes no artifacts (ADR-0002).' },
    ]);
  },
);

test('checkout, Rust caching, and artifact upload are explicit no-ops with reasons', async () => {
  const result = await resolveToolchains(
    plan(
      action('actions/checkout@v7', { 'persist-credentials': 'false' }),
      action('Swatinem/rust-cache@refs/tags/v2', {}, 2),
      action(
        'actions/upload-artifact@v7',
        { 'if-no-files-found': 'warn', name: 'binary', path: 'dist/binary' },
        3,
      ),
    ),
    readNothing,
  );
  expect(result.tools).toEqual([]);
  expect(result.actions).toMatchObject([
    { kind: 'noop', reason: 'The runner checks out the commit without credentials.' },
    { kind: 'noop', reason: 'The golden image holds warm Rust caches.' },
    { kind: 'noop', reason: 'Verification only: Hugi publishes no artifacts (ADR-0002).' },
  ]);
});

test('rust-toolchain.toml selects Rust without a setup action and records rustup responsibilities', async () => {
  const result = await resolveToolchains(plan(), async (path) =>
    path === 'rust-toolchain.toml'
      ? '[toolchain]\nchannel = "1.97.1"\ncomponents = ["clippy", "rustfmt"]\nprofile = "minimal"\n'
      : undefined,
  );
  expect(result.tools).toEqual(['rust@1.97.1']);
  expect(result.actions).toEqual([]);
  expect(result.notes).toEqual([
    'rust-toolchain.toml: rustup in the guest handles components and profile.',
  ]);
});

test.each(['1.97.1', '1.97.1\n', '1.97.1\r\n'])(
  'the root legacy rust-toolchain selects a one-line pinned channel: %j',
  async (contents) => {
    const result = await resolveToolchains(plan(), async (path) =>
      path === 'rust-toolchain' ? contents : undefined,
    );
    expect(result.tools).toEqual(['rust@1.97.1']);
    expect(result.actions).toEqual([]);
    expect(result.notes).toEqual([
      'rust-toolchain: rustup in the guest handles components and profile.',
    ]);
  },
);

test('the legacy rust-toolchain also accepts a TOML channel and records its source', async () => {
  const result = await resolveToolchains(plan(), async (path) =>
    path === 'rust-toolchain'
      ? '[toolchain]\nchannel = "1.97.1"\ncomponents = ["clippy"]\nprofile = "minimal"\n'
      : undefined,
  );
  expect(result.tools).toEqual(['rust@1.97.1']);
  expect(result.notes).toEqual([
    'rust-toolchain: rustup in the guest handles components and profile.',
  ]);
});

test.each(['1.97.1\n', '[toolchain]\nchannel = "1.97.1"\n'])(
  'rust-toolchain takes precedence over rust-toolchain.toml: %j',
  async (legacy) => {
    const result = await resolveToolchains(plan(), async (path) => {
      if (path === 'rust-toolchain') {
        return legacy;
      }
      return path === 'rust-toolchain.toml' ? '[toolchain]\nchannel = "nightly"\n' : undefined;
    });
    expect(result.tools).toEqual(['rust@1.97.1']);
    expect(result.notes).toEqual([
      'rust-toolchain: rustup in the guest handles components and profile.',
    ]);
  },
);

test.each([
  '',
  'stable\n',
  'nightly\n',
  'beta\n',
  '[toolchain]\nprofile = "minimal"\n',
  '[invalid',
])(
  'an invalid legacy rust-toolchain fails without falling back to a pinned TOML file: %j',
  async (legacy) => {
    const resolution = resolveToolchains(
      plan(action('actions/setup-node@v7', { 'node-version': '22' })),
      async (path) => {
        if (path === 'rust-toolchain') {
          return legacy;
        }
        return path === 'rust-toolchain.toml' ? '[toolchain]\nchannel = "1.97.1"\n' : undefined;
      },
    );
    (await expectFailure(resolution)).toThrow(ToolchainResolutionError);
    (await expectFailure(resolution)).toThrow('rust-toolchain:');
    if (['stable\n', 'nightly\n', 'beta\n'].includes(legacy)) {
      (await expectFailure(resolution)).toThrow(`unpinned rust version "${legacy.trim()}"`);
    }
  },
);

test.each(['pnpm', 'npm', 'yarn'])('Node cache %s is recorded as a no-op', async (cache) => {
  const result = await resolveToolchains(
    plan(action('actions/setup-node@v7', { cache, 'node-version': '22.23.2' })),
    readNothing,
  );
  expect(result.tools).toEqual(['node@22.23.2']);
  expect(result.actions).toMatchObject([
    { kind: 'tools', notes: [`${cache} cache: the golden image holds warm package caches.`] },
  ]);
});

test('Node rejects a cache backend outside its supported list', async () => {
  (
    await expectFailure(
      resolveToolchains(
        plan(action('actions/setup-node@v7', { cache: 'custom', 'node-version': '22' })),
        readNothing,
      ),
    )
  ).toThrow('unsupported cache "custom"');
});

test.each(
  ['nightly-2026-10-01', 'beta-2026-10-01', 'stable-2026-10-01'].flatMap((channel) => [
    { channel, contents: `[toolchain]\nchannel = "${channel}"\n`, source: 'rust-toolchain.toml' },
    { channel, contents: channel, source: 'rust-toolchain' },
    { channel, contents: `[toolchain]\nchannel = "${channel}"\n`, source: 'rust-toolchain' },
  ]),
)(
  'a dated Rust channel $channel in $source is pinned: $contents',
  async ({ channel, contents, source }) => {
    const result = await resolveToolchains(plan(), async (path) =>
      path === source ? contents : undefined,
    );
    expect(result.tools).toEqual([`rust@${channel}`]);
  },
);

test.each([
  'actions/checkout@v7',
  'actions/setup-node@v7',
  'oven-sh/setup-bun@v2',
  'pnpm/action-setup@v6',
  'Swatinem/rust-cache@v2',
  'actions/upload-artifact@v7',
])('%s rejects every input outside its allowlist', async (uses) => {
  const resolution = resolveToolchains(plan(action(uses, { surprise: 'true' })), readNothing);
  (await expectFailure(resolution)).toThrow(UnsupportedActionError);
  (await expectFailure(resolution)).toThrow('unsupported input "surprise"');
});

test.each(['actions/setup-node@v7', 'oven-sh/setup-bun@v2'])(
  '%s rejects the implicit latest version',
  async (uses) => {
    (await expectFailure(resolveToolchains(plan(action(uses)), readNothing))).toThrow(
      /unpinned .* version "latest"/u,
    );
  },
);

test.each<{ contents: string | undefined; inputs: Record<string, string>; reason: string }>([
  {
    contents: undefined,
    inputs: { 'bun-version-file': '.tool-versions' },
    reason: 'was not found',
  },
  {
    contents: 'nodejs 22\n',
    inputs: { 'bun-version-file': '.tool-versions' },
    reason: 'exactly one bun version',
  },
  {
    contents: 'bun 1.4.4 1.4.3\n',
    inputs: { 'bun-version-file': '.tool-versions' },
    reason: 'exactly one bun version',
  },
  {
    contents: 'bun 1.4.4\nbun 1.4.4\n',
    inputs: { 'bun-version-file': '.tool-versions' },
    reason: 'exactly one bun version',
  },
  {
    contents: 'bun latest\n',
    inputs: { 'bun-version-file': '.tool-versions' },
    reason: 'unpinned bun version',
  },
  {
    contents: 'bun 1.4.4\n',
    inputs: { 'bun-version-file': '../.tool-versions' },
    reason: 'repository-relative path',
  },
  {
    contents: 'bun 1.4.4\n',
    inputs: { 'bun-version-file': '/.tool-versions' },
    reason: 'repository-relative path',
  },
  {
    contents: 'bun 1.4.4\n',
    inputs: { 'bun-version': '1.4.4', 'bun-version-file': '.tool-versions' },
    reason: 'use only one',
  },
])('Bun version-file failure is contextual and typed: %j', async ({ inputs, contents, reason }) => {
  const resolution = resolveToolchains(
    plan(action('oven-sh/setup-bun@v2', inputs)),
    async () => contents,
  );
  (await expectFailure(resolution)).toThrow(UnsupportedActionError);
  (await expectFailure(resolution)).toThrow(reason);
});

test.each([
  undefined,
  '{}',
  '{"packageManager":"npm@12.0.0"}',
  '{"packageManager":"pnpm@latest"}',
  '{"packageManager":"pnpm@^12.0.0"}',
  '{"packageManager":42}',
  '{"packageManager":"pnpm@12.0.0+anything"}',
  '{invalid',
])('pnpm fails on missing or invalid packageManager: %j', async (manifest) => {
  const resolution = resolveToolchains(plan(action('pnpm/action-setup@v6')), async () => manifest);
  (await expectFailure(resolution)).toThrow(UnsupportedActionError);
});

test.each(
  [
    '[toolchain]\nchannel = "stable"',
    '[toolchain]\nchannel = "nightly"',
    '[toolchain]\nchannel = "beta"',
    '[toolchain]\nchannel = "latest"',
    '[toolchain]\nchannel = "1.x"',
    '[toolchain]\nchannel = 1',
    '[toolchain]\nprofile = "minimal"',
    '[invalid',
  ].flatMap((contents) =>
    ['rust-toolchain', 'rust-toolchain.toml'].map((source) => ({ contents, source })),
  ),
)('Rust rejects an invalid or unpinned $source file: $contents', async ({ contents, source }) => {
  const resolution = resolveToolchains(plan(), async (path) =>
    path === source ? contents : undefined,
  );
  (await expectFailure(resolution)).toThrow(ToolchainResolutionError);
  (await expectFailure(resolution)).toThrow(`${source}:`);
});

test.each(['rust-toolchain', 'rust-toolchain.toml'])(
  'Rust file read failures in %s remain typed rather than returning the action tools',
  async (source) => {
    const resolution = resolveToolchains(
      plan(action('oven-sh/setup-bun@v2', { 'bun-version': '1.4.4' })),
      async (path) => {
        if (path === source) {
          throw new Error('repository read failed');
        }
        return undefined;
      },
    );
    (await expectFailure(resolution)).toThrow(ToolchainResolutionError);
    (await expectFailure(resolution)).toThrow(`${source}: repository read failed`);
  },
);

test.each([
  'docker://alpine:3',
  './local-action',
  'actions/setup-node/path@v7',
  'actions/setup-node',
])('an unsupported action reference %s fails independently of the reader', async (uses) => {
  (await expectFailure(resolveToolchains(plan(action(uses)), readNothing))).toThrow(
    UnsupportedActionError,
  );
});

test.each([
  'actions/checkout@v7 # tag comment',
  'actions/checkout@ea17c68df8912ef543352723c149a84f56e3d413 # v7',
  'actions/checkout@v7\t# tag comment',
])(
  'an action reference containing a trailing comment %j fails at the resolver boundary',
  async (uses) => {
    const resolution = resolveToolchains(plan(action(uses, {}, 4)), readNothing);
    (await expectFailure(resolution)).toThrow(UnsupportedActionError);
    (await expectFailure(resolution)).toThrow(
      `step 4 "Set up tools 4" (${uses}): unsupported action`,
    );
  },
);

test.each([
  'actions/checkout@v7',
  'ACTIONS/CHECKOUT@main',
  'actions/checkout@refs/tags/v7',
  'actions/checkout@ea17c68df8912ef543352723c149a84f56e3d413',
])(
  'an action reference with a tag, branch, or SHA pin %s resolves without a comment',
  async (uses) => {
    const result = await resolveToolchains(plan(action(uses)), readNothing);
    expect(result.tools).toEqual([]);
    expect(result.actions).toMatchObject([{ kind: 'noop', uses }]);
  },
);

test('run steps add no tools and are not interpreted as setup actions', async () => {
  const result = await resolveToolchains(
    plan({
      continueOnError: false,
      env: {},
      index: 1,
      kind: 'run',
      name: 'Use the toolchain',
      script: 'node --version',
      shell: 'bash',
      when: 'success',
    }),
    readNothing,
  );
  expect(result).toEqual({ actions: [], notes: [], tools: [] });
});
