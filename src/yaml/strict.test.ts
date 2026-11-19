import { expect, test } from 'bun:test';

import { messageOf } from '../errors';
import { YamlRefusalError, parseStrictYaml } from './strict';

function refusal(text: string): string {
  try {
    parseStrictYaml(text);
  } catch (error) {
    expect(error).toBeInstanceOf(YamlRefusalError);
    return messageOf(error);
  }
  throw new Error('expected the YAML to be refused');
}

test('reads plain values', () => {
  expect(parseStrictYaml('a: 1\nb: [x, true, null]\nc: {d: e}')).toEqual({
    a: 1,
    b: ['x', true, null],
    c: { d: 'e' },
  });
});

test('reads the YAML 1.2 core schema, so yes and no stay strings', () => {
  expect(parseStrictYaml('a: yes\nb: no\nc: on\nd: true')).toEqual({
    a: 'yes',
    b: 'no',
    c: 'on',
    d: true,
  });
});

test('an empty text reads as null', () => {
  expect(parseStrictYaml('')).toBeNull();
});

test('refuses a %YAML directive, naming its place', () => {
  expect(refusal('%YAML 1.1\n---\na: 1')).toBe(
    'YAML directives are not allowed at line 1, column 1',
  );
});

test('refuses a %TAG directive', () => {
  expect(refusal('%TAG !e! tag:example.com,2000:\n---\na: 1')).toBe(
    'YAML directives are not allowed at line 1, column 1',
  );
});

test('refuses a duplicate key, naming its place', () => {
  expect(refusal('a: 1\nb: 2\na: 3')).toMatch(/unique.* at line 3, column 1$/);
});

test('refuses a merge key', () => {
  expect(refusal('base: &b {x: 1}\nuse:\n  <<: {x: 2}')).toMatch(/anchors|merge keys \(<<\)/);
  expect(refusal('use:\n  <<: {x: 2}')).toBe(
    'YAML merge keys (<<) are not allowed at line 2, column 3',
  );
});

test('refuses an anchor and an alias', () => {
  expect(refusal('a: &x 1')).toBe('YAML anchors are not allowed (&x) at line 1, column 7');
});

test('refuses an alias used as a mapping key as an alias', () => {
  expect(refusal('x: &a k\n*a : 2\n')).toMatch(/alias/i);
});

test('refuses an alias, even one that names no anchor', () => {
  expect(refusal('a: [*x]')).toMatch(/alias/i);
  expect(refusal('- &x 1\n- *x')).toMatch(/anchors are not allowed/);
});

test('refuses explicit tags, standard or custom', () => {
  expect(refusal('a: !!str 1')).toBe(
    'explicit YAML tags are not allowed (tag:yaml.org,2002:str) at line 1, column 10',
  );
  expect(refusal('a: !custom 1')).toMatch(/explicit YAML tags are not allowed \(!custom\)/);
});

test('refuses malformed YAML and a second document, with a location', () => {
  expect(refusal('a: [1,\n')).toMatch(/ at line 2, column 1$/);
  expect(refusal('--- a\n--- b')).toMatch(/multiple documents.* at line 2, column 1$/);
});

test.each([
  ['m: {1: a, "1": b}', 'line 1, column 11'],
  ['m: {true: a, "true": b}', 'line 1, column 14'],
  ['m: {null: a, "": b}', 'line 1, column 14'],
])('refuses keys of one mapping that read as the same property: %s', (text, place) => {
  expect(refusal(text)).toBe(
    `the key repeats another key of its mapping, read as text at ${place}`,
  );
});

test('refuses a collection key, naming its place', () => {
  expect(refusal('[a]: 1')).toBe(
    'a mapping key must be a scalar, not a collection at line 1, column 1',
  );
  expect(refusal('{a: b}: 1')).toMatch(/must be a scalar/);
});

test('reads distinct scalar keys that look alike', () => {
  expect(parseStrictYaml('m: {1: a, "2": b, true: c, "t": d}')).toEqual({
    m: { '1': 'a', '2': 'b', t: 'd', true: 'c' },
  });
});
