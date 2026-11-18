import { expect, test } from 'bun:test';

import { parseLaneArgument, parseMatrix, parseNeeds, RunUsageError } from './run-args';

test('a bare workflow file name lives under .github/workflows', () => {
  expect(parseLaneArgument('ci.yml:platform')).toEqual({
    job: 'platform',
    workflow: '.github/workflows/ci.yml',
  });
});

test('a workflow with a directory is taken as a repository path', () => {
  expect(parseLaneArgument('./.github/workflows/ci.yml:build')).toEqual({
    job: 'build',
    workflow: '.github/workflows/ci.yml',
  });
  expect(parseLaneArgument('ci/other.yml:build').workflow).toBe('ci/other.yml');
});

test('the job is whatever follows the last colon', () => {
  expect(parseLaneArgument('ci.yml:node_matrix').job).toBe('node_matrix');
});

test.each(['ci.yml', ':job', 'ci.yml:', '', './:build'])('lane %p is a usage error', (text) => {
  expect(() => parseLaneArgument(text)).toThrow(RunUsageError);
});

test('matrix entries split at the first equals sign and stay strings', () => {
  expect(parseMatrix(['os=macos-latest', 'node=22', 'flag=a=b'])).toEqual({
    flag: 'a=b',
    node: '22',
    os: 'macos-latest',
  });
});

test.each([[['novalue']], [['=x']], [['a=1', 'a=2']]])('matrix %p is a usage error', (entries) => {
  expect(() => parseMatrix(entries)).toThrow(RunUsageError);
});

test('needs entries build upstream outputs per job', () => {
  expect(
    parseNeeds(['changes.outputs.code=true', 'changes.outputs.docs=false', 'setup.outputs.v=1']),
  ).toEqual({
    changes: { outputs: { code: 'true', docs: 'false' } },
    setup: { outputs: { v: '1' } },
  });
});

test.each([
  [['changes.code=true']],
  [['changes.outputs.=x']],
  [['x']],
  [['a.outputs.b=1', 'a.outputs.b=2']],
])('needs %p is a usage error', (entries) => {
  expect(() => parseNeeds(entries)).toThrow(RunUsageError);
});

test.each(['__proto__', 'constructor', 'prototype'])(
  'a matrix key named %p is a usage error',
  (key) => {
    expect(() => parseMatrix([`${key}=1`])).toThrow(RunUsageError);
  },
);

test.each([
  '__proto__.outputs.x=1',
  'constructor.outputs.x=1',
  'changes.outputs.__proto__=1',
  'changes.outputs.prototype=1',
])('needs %p is a usage error', (entry) => {
  expect(() => parseNeeds([entry])).toThrow(RunUsageError);
});

test('the parsed maps have no prototype, so a key cannot reach Object.prototype', () => {
  expect(Object.getPrototypeOf(parseMatrix(['os=macos-latest']))).toBeNull();
  const needs = parseNeeds(['changes.outputs.code=true']);
  expect(Object.getPrototypeOf(needs)).toBeNull();
  expect(Object.getPrototypeOf(needs.changes!.outputs)).toBeNull();
});
