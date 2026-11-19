import { expect, test } from 'bun:test';

import { messageOf } from './errors';

test('an Error gives its message; anything else gives its string form', () => {
  expect(messageOf(new Error('boom'))).toBe('boom');
  expect(messageOf('plain')).toBe('plain');
  expect(messageOf(42)).toBe('42');
});

test('a value whose string form throws is described by a fixed text, never a throw', () => {
  const bare: unknown = Object.create(null);
  expect(() => String(bare)).toThrow();
  expect(messageOf(bare)).toBe('an error that cannot be described');
  const hostile = {
    toString() {
      throw new Error('no');
    },
  };
  expect(messageOf(hostile)).toBe('an error that cannot be described');
});

test("an Error whose message is not a string gives that message's string form", () => {
  const error = new Error('x');
  Object.defineProperty(error, 'message', { value: 7 });
  expect(messageOf(error)).toBe('7');
});
