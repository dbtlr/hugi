import { expect, test } from 'bun:test';

import { readLane } from './reader';
import type { EventContext, LaneRef } from './step-plan';

const paths = { temp: '/tmp/runner', workspace: '/work' };
const fixtures: readonly {
  fixture: string;
  oracle: string;
  lane: LaneRef;
  event: EventContext;
  name: string;
  timeout: number;
  count: number;
}[] = [
  {
    count: 17,
    event: {
      event: 'push',
      refName: 'main',
      refType: 'branch',
      repository: 'dbtlr/norn',
      sha: '7e71dfe81',
    },
    fixture: 'norn-ci.yml',
    lane: { job: 'platform', matrix: {}, workflow: '.github/workflows/ci.yml' },
    name: 'determinism and filesystem (macOS ARM64)',
    oracle: 'norn-platform',
    timeout: 30,
  },
  {
    count: 8,
    event: {
      event: 'push',
      needs: { changes: { outputs: { code: 'true' } } },
      refName: 'main',
      refType: 'branch',
      repository: 'dbtlr/loomcli',
      sha: '90f72d52b',
    },
    fixture: 'loom-ci.yml',
    lane: {
      job: 'node_matrix',
      matrix: { os: 'macos-latest' },
      workflow: '.github/workflows/ci.yml',
    },
    name: 'node / macos-latest',
    oracle: 'loom-node',
    timeout: 360,
  },
  {
    count: 8,
    event: {
      event: 'push',
      needs: { changes: { outputs: { code: 'true' } } },
      refName: 'main',
      refType: 'branch',
      repository: 'dbtlr/loomcli',
      sha: '90f72d52b',
    },
    fixture: 'loom-ci.yml',
    lane: {
      job: 'bun_matrix',
      matrix: { os: 'macos-latest' },
      workflow: '.github/workflows/ci.yml',
    },
    name: 'bun / macos-latest',
    oracle: 'loom-bun',
    timeout: 360,
  },
  {
    count: 8,
    event: {
      event: 'push',
      refName: 'v0.29.0',
      refType: 'tag',
      repository: 'dbtlr/mimir',
      sha: '810a1fb3f',
    },
    fixture: 'mimir-release.yml',
    lane: {
      job: 'build',
      matrix: { asset: 'mimir-darwin-arm64', os: 'macos-latest' },
      workflow: '.github/workflows/release.yml',
    },
    name: 'build mimir-darwin-arm64',
    oracle: 'mimir-build',
    timeout: 360,
  },
];

// Run names and scripts captured from the spike's plan/condition/expand at the pinned commits.
test.each(fixtures)("$oracle matches the spike's ordered, expanded run steps", async (fixture) => {
  const text = await Bun.file(new URL(`fixtures/${fixture.fixture}`, import.meta.url)).text();
  const expected: unknown = await Bun.file(
    new URL(`fixtures/${fixture.oracle}.runs.json`, import.meta.url),
  ).json();
  const plan = readLane(text, fixture.lane, fixture.event, paths);
  expect(plan.name).toBe(fixture.name);
  expect(plan.timeoutMinutes).toBe(fixture.timeout);
  expect(plan.steps).toHaveLength(fixture.count);
  const runs = plan.steps
    .filter((step) => step.kind === 'run')
    .map(({ name, script }) => ({ name, script }));
  expect(expected).toEqual(runs);
  if (fixture.oracle.startsWith('loom-')) {
    expect(plan.env).toEqual({
      LOOM_REQUIRE_SHELLS: '1',
      LOOM_TEST_RUNTIME: fixture.oracle === 'loom-node' ? 'node' : 'bun',
      NODE_COMPILE_CACHE: '/work/../node-compile-cache',
    });
    expect(plan.steps.map(({ index }) => index)).toEqual([1, 2, 3, 4, 5, 7, 8, 9]);
  }
  if (fixture.oracle === 'mimir-build') {
    expect(plan.steps[5]?.env).toEqual({ ASSET: 'mimir-darwin-arm64' });
    expect(plan.steps[6]?.env).toEqual({
      MIMIR_SANDBOX_LIFECYCLE_TEST: '1',
      MIMIR_TEST_BINARY: '/work/dist/mimir-darwin-arm64',
    });
    expect(plan.steps[7]).toMatchObject({
      kind: 'action',
      with: {
        'if-no-files-found': 'error',
        name: 'mimir-darwin-arm64',
        path: 'dist/mimir-darwin-arm64',
      },
    });
  }
});

test('the verbatim Loom lane requires explicit upstream outputs and rejects a false guard', async () => {
  const text = await Bun.file(new URL('fixtures/loom-ci.yml', import.meta.url)).text();
  const fixture = fixtures[1]!;
  const { needs: _needs, ...event } = fixture.event;
  expect(() => readLane(text, fixture.lane, event, paths)).toThrow(/needs.changes.outputs.code/);
  expect(() =>
    readLane(
      text,
      fixture.lane,
      { ...event, needs: { changes: { outputs: { code: 'false' } } } },
      paths,
    ),
  ).toThrow(/job does not run for this event/);
});
