import { expect, test } from 'bun:test';

import { DECLARATION_STATUS, laneStatusName, statusNameKey } from './status-name';

const lane = (job: string, matrix: Record<string, string | number | boolean> = {}) => ({
  job,
  matrix,
  workflow: '.github/workflows/ci.yml',
});

test('a lane without a matrix row is named for its job', () => {
  expect(laneStatusName(lane('platform'))).toBe('hugi / platform');
});

test("a lane with a row lists the row's values in its key order, comma and space separated", () => {
  const row = Object.fromEntries([
    ['os', 'macos-latest'],
    ['node', 22],
    ['bun', true],
  ]);
  expect(laneStatusName(lane('test', row))).toBe('hugi / test (macos-latest, 22, true)');
});

test('the workflow path is not part of the name, so promotion keeps it', () => {
  expect(laneStatusName({ ...lane('build'), workflow: '.github/hugi/ci.yml' })).toBe(
    'hugi / build',
  );
});

test('the declaration status is named hugi', () => {
  expect(DECLARATION_STATUS).toBe('hugi');
});

test('two names that differ only in case have one key, as GitHub treats them as one context', () => {
  expect(statusNameKey('HUGI / Build (macOS-15)')).toBe(statusNameKey('hugi / build (macos-15)'));
  expect(statusNameKey('hugi / build')).not.toBe(statusNameKey('hugi / build2'));
});
