import { expect, test } from 'bun:test';

import { buildCheckoutScript } from './checkout';
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

test('the checkout fetches only the commit, at depth 1 with no tags, as actions/checkout does by default', () => {
  const script = buildCheckoutScript(
    requestWith({ cloneUrl: 'https://github.com/dbtlr/hugi.git', kind: 'remote' }),
  );
  expect(gitCommands(script)).toEqual([
    "git init -q '/Users/admin/hugi/workspace'",
    "git -C '/Users/admin/hugi/workspace' remote add origin 'https://github.com/dbtlr/hugi.git'",
    "git -C '/Users/admin/hugi/workspace' -c protocol.version=2 fetch --depth 1 --no-tags --no-recurse-submodules origin 'abc123'",
    "git -C '/Users/admin/hugi/workspace' -c advice.detachedHead=false checkout --detach FETCH_HEAD",
  ]);
  expect(script).not.toContain(' clone ');
});

test('a local source is fetched over a file:// URL, so the shallow fetch applies', () => {
  const script = buildCheckoutScript(requestWith({ kind: 'local', path: '/mock/repo' }));
  expect(gitCommands(script)).toContain(
    "git -C '/Users/admin/hugi/workspace' remote add origin 'file:///Volumes/My Shared Files/source'",
  );
});
