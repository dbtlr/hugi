import { expect, test } from 'bun:test';

import { readLane } from '../lane/reader';
import type { EventContext, LaneRef } from '../lane/step-plan';
import { resolveToolchains } from './resolver';

const paths = { temp: '/tmp/runner', workspace: '/work' };
const fixtures: readonly {
  name: string;
  workflow: string;
  repository: string;
  lane: LaneRef;
  event: EventContext;
  tools: readonly string[];
  notes: readonly string[];
  noops: number;
}[] = [
  {
    event: {
      event: 'push',
      refName: 'main',
      refType: 'branch',
      repository: 'dbtlr/norn',
      sha: '7e71dfe81',
    },
    lane: { job: 'platform', matrix: {}, workflow: '.github/workflows/ci.yml' },
    name: 'norn platform',
    noops: 2,
    notes: ['rust-toolchain.toml: rustup in the guest handles components and profile.'],
    repository: 'norn',
    tools: ['rust@1.97.1'],
    workflow: 'norn-ci.yml',
  },
  ...(['node', 'bun'] as const).map((runtime) => ({
    event: {
      event: 'push',
      needs: { changes: { outputs: { code: 'true' } } },
      refName: 'main',
      refType: 'branch',
      repository: 'dbtlr/loomcli',
      sha: '90f72d52b',
    } satisfies EventContext,
    lane: {
      job: `${runtime}_matrix`,
      matrix: { os: 'macos-latest' },
      workflow: '.github/workflows/ci.yml',
    },
    name: `Loom ${runtime}`,
    noops: 1,
    notes: [],
    repository: 'loomcli',
    tools: ['pnpm@12.16.1', 'node@22.23.2', 'bun@1.4.4'],
    workflow: 'loom-ci.yml',
  })),
  {
    event: {
      event: 'push',
      refName: 'v0.29.0',
      refType: 'tag',
      repository: 'dbtlr/mimir',
      sha: '810a1fb3f',
    },
    lane: {
      job: 'build',
      matrix: { asset: 'mimir-darwin-arm64', os: 'macos-latest' },
      workflow: '.github/workflows/release.yml',
    },
    name: 'Mimir build',
    noops: 2,
    notes: [],
    repository: 'mimir',
    tools: ['bun@1.4.4'],
    workflow: 'mimir-release.yml',
  },
];

test.each(fixtures)(
  '$name resolves the committed workflow into an explicit tool set',
  async (fixture) => {
    const workflow = await Bun.file(
      new URL(`../lane/fixtures/${fixture.workflow}`, import.meta.url),
    ).text();
    const plan = readLane(workflow, fixture.lane, fixture.event, paths);
    const result = await resolveToolchains(plan, async (path) => {
      const file = Bun.file(new URL(`fixtures/${fixture.repository}/${path}`, import.meta.url));
      return (await file.exists()) ? file.text() : undefined;
    });
    expect(result.tools).toEqual(fixture.tools);
    expect(result.notes).toEqual(fixture.notes);
    expect(result.actions.map(({ index, name, uses }) => ({ index, name, uses }))).toEqual(
      plan.steps
        .filter((step) => step.kind === 'action')
        .map(({ index, name, uses }) => ({ index, name, uses })),
    );
    const noops = result.actions.filter((action) => action.kind === 'noop');
    expect(noops).toHaveLength(fixture.noops);
    for (const noop of noops) {
      expect(noop.reason).not.toBe('');
    }
    if (fixture.repository === 'loomcli') {
      expect(result.actions).toMatchObject([
        { kind: 'noop' },
        { kind: 'tools', tools: ['pnpm@12.16.1'] },
        {
          kind: 'tools',
          notes: ['pnpm cache: the golden image holds warm package caches.'],
          tools: ['node@22.23.2'],
        },
        { kind: 'tools', tools: ['bun@1.4.4'] },
      ]);
    }
  },
);
