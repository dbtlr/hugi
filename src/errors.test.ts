import { expect, test } from 'bun:test';

import { messageOf } from './errors';

test('an Error gives its message; anything else gives its string form', () => {
  expect(messageOf(new Error('boom'))).toBe('boom');
  expect(messageOf('plain')).toBe('plain');
  expect(messageOf(42)).toBe('42');
});
