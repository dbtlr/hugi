import { expect, test } from 'bun:test';

import type { ActionStep } from '../lane/step-plan';
import { buildCheckoutScript, buildWorkspaceScript, checkoutStepIndex } from './checkout';
import { GUEST_STAGING_REPO } from './guest-paths';
import type { RunRequest } from './run-request';

const SHA = 'abc123';

const requestWith = (source: RunRequest['source']): RunRequest => ({
  event: { event: 'push', refName: 'main', refType: 'branch', repository: 'dbtlr/hugi', sha: SHA },
  image: 'hugi-golden',
  logDir: '/mock/logs',
  plan: {
    env: {},
    lane: { job: 'test', matrix: {}, workflow: '.github/workflows/ci.yml' },
    name: 'test',
    steps: [],
    timeoutMinutes: 10,
  },
  source,
  tools: [],
});

/** The script's git commands, in order, with the shared config prefix dropped. */
const gitCommands = (script: string): string[] =>
  script
    .split('\n')
    .filter((line) => line.startsWith('git '))
    .map((line) => line.replace("git -c safe.directory='*' ", 'git '));

const REMOTE = { cloneUrl: 'https://github.com/dbtlr/hugi.git', kind: 'remote' } as const;

test('the run starts by fetching only the commit into a staging repository, not the workspace', () => {
  const script = buildCheckoutScript(requestWith(REMOTE));
  expect(gitCommands(script)).toEqual([
    `git init -q --bare '${GUEST_STAGING_REPO}'`,
    `git -C '${GUEST_STAGING_REPO}' -c protocol.version=2 fetch --depth 1 --no-tags --no-recurse-submodules 'https://github.com/dbtlr/hugi.git' 'abc123'`,
    `git -C '${GUEST_STAGING_REPO}' update-ref refs/hugi/commit 'abc123'`,
  ]);
  expect(GUEST_STAGING_REPO.startsWith('/Users/admin/hugi/workspace')).toBe(false);
  // The workspace exists, empty, as on GitHub before actions/checkout runs.
  expect(script).toContain("mkdir -p '/Users/admin/hugi/temp' ");
  expect(script).toContain("'/Users/admin/hugi/workspace'");
  expect(script).not.toContain(' clone ');
});

test('a local source is fetched over a file:// URL, so the shallow fetch applies', () => {
  const script = buildCheckoutScript(requestWith({ kind: 'local', path: '/mock/repo' }));
  expect(script).toContain("'file:///Volumes/My Shared Files/source' 'abc123'");
});

test('the checkout step materializes the workspace from staging: detached, depth 1, no tags', () => {
  const script = buildWorkspaceScript(requestWith(REMOTE));
  expect(gitCommands(script)).toEqual([
    "git init -q '/Users/admin/hugi/workspace'",
    "git -C '/Users/admin/hugi/workspace' remote add origin 'https://github.com/dbtlr/hugi.git'",
    `git -C '/Users/admin/hugi/workspace' -c protocol.version=2 fetch --depth 1 --no-tags --no-recurse-submodules 'file://${GUEST_STAGING_REPO}' 'abc123'`,
    "git -C '/Users/admin/hugi/workspace' -c advice.detachedHead=false checkout --detach FETCH_HEAD",
  ]);
  expect(script).toContain('checked out abc123');
});

const action = (index: number, uses: string): ActionStep => ({
  continueOnError: false,
  env: {},
  index,
  kind: 'action',
  name: uses,
  uses,
  when: 'success',
  with: {},
});

const plan = (steps: ActionStep[]) => ({ ...requestWith(REMOTE).plan, steps });

test('the first actions/checkout step, in any case, is the one that materializes the workspace', () => {
  expect(checkoutStepIndex(plan([action(1, 'oven-sh/setup-bun@v2')]))).toBeUndefined();
  expect(
    checkoutStepIndex(
      plan([
        action(1, 'oven-sh/setup-bun@v2'),
        action(2, 'Actions/Checkout@v4'),
        action(3, 'actions/checkout@v4'),
      ]),
    ),
  ).toBe(2);
});
