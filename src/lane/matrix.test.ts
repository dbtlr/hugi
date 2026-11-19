/* Workflow expression delimiters are literal input to the matrix expander. */
/* eslint-disable no-template-curly-in-string */
import { describe, expect, test } from 'bun:test';

import { MAX_MATRIX_KEYS, matrixRows, readMatrixEntries } from './matrix';
import type { MatrixEntryProblem } from './matrix';

test('expands a literal matrix', () => {
  expect(matrixRows({ matrix: { include: [{ extra: 'x' }], os: ['a', 'b'] } })).toEqual([
    { extra: 'x', os: 'a' },
    { extra: 'x', os: 'b' },
  ]);
});

test.each([
  { matrix: { os: ['${{ fromJSON(vars.V) }}'] } },
  { matrix: { include: [{ extra: '${{ vars.E }}' }], os: ['a'] } },
  { matrix: { exclude: [{ os: 'x${{ vars.E }}' }], os: ['a'] } },
])('refuses an expression in a matrix value, as it cannot be expanded: %j', (strategy) => {
  expect(() => matrixRows(strategy)).toThrow(/expression/);
});

test('expands in GitHub order, the first axis varying slowest', () => {
  expect(matrixRows({ matrix: { n: [1, 2], os: ['a', 'b'] } })).toEqual([
    { n: 1, os: 'a' },
    { n: 1, os: 'b' },
    { n: 2, os: 'a' },
    { n: 2, os: 'b' },
  ]);
});

function axes(count: number): Record<string, string[]> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, ['v']]));
}

/** One include entry that adds `count` keys. */
const include = (count: number) => [
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`x${index}`, 'v'])),
];

describe('the keys of a matrix', () => {
  test('accepts the cap in axes, expanded without copying rows per axis', () => {
    const rows = matrixRows({ matrix: axes(MAX_MATRIX_KEYS) })!;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!)).toHaveLength(MAX_MATRIX_KEYS);
  });

  test('refuses one axis past the cap, naming it', () => {
    expect(() => matrixRows({ matrix: axes(MAX_MATRIX_KEYS + 1) })).toThrow(/more than the 256/);
  });

  test('counts the keys include entries add', () => {
    expect(
      matrixRows({ matrix: { ...axes(1), include: include(MAX_MATRIX_KEYS - 1) } }),
    ).toHaveLength(1);
    expect(() => matrixRows({ matrix: { ...axes(1), include: include(MAX_MATRIX_KEYS) } })).toThrow(
      /more than the 256/,
    );
  });
});

/** `count` include or exclude entries over a few keys. */
const listEntries = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ k0: 'v', [`x${index % 8}`]: 'v' }));

describe('the include and exclude lists of a matrix', () => {
  test('accept 256 entries each', () => {
    expect(
      matrixRows({ matrix: { ...axes(1), exclude: listEntries(256), include: listEntries(256) } }),
    ).toBeDefined();
  });

  test('refuse a 257th include entry, naming the cap', () => {
    expect(() => matrixRows({ matrix: { ...axes(1), include: listEntries(257) } })).toThrow(
      /matrix\.include has 257 entries, more than the 256/,
    );
  });

  test('refuse a 257th exclude entry, naming the cap', () => {
    expect(() => matrixRows({ matrix: { ...axes(1), exclude: listEntries(257) } })).toThrow(
      /matrix\.exclude has 257 entries, more than the 256/,
    );
  });
});

test('an include merged into a row keeps a __proto__ key as an own key, as one it appends does', () => {
  const rows = matrixRows({
    matrix: { include: [JSON.parse('{"os": "m1", "__proto__": "x"}')], os: ['m1', 'm2'] },
  })!;
  expect(Object.hasOwn(rows[0]!, '__proto__')).toBe(true);
  expect(rows[0]!.__proto__).toBe('x');
});

describe('matrix entries', () => {
  test('split at the first equals sign into a map with no prototype', () => {
    const result = readMatrixEntries(['os=mac', 'flag=a=b']);
    expect(result).toEqual({ matrix: { flag: 'a=b', os: 'mac' } });
    if ('matrix' in result) {
      expect(Object.getPrototypeOf(result.matrix)).toBeNull();
    }
  });

  test.each<[string[], MatrixEntryProblem]>([
    [['novalue'], { entry: 'novalue', kind: 'not-key-value' }],
    [['=x'], { entry: '=x', kind: 'not-key-value' }],
    [['constructor=x'], { entry: 'constructor=x', key: 'constructor', kind: 'reserved-key' }],
    [['a=1', 'a=2'], { key: 'a', kind: 'repeated-key' }],
  ])('returns a typed problem for %j', (entries, problem) => {
    expect(readMatrixEntries(entries)).toEqual({ problem });
  });
});
