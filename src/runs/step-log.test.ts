import { expect, test } from 'bun:test';

import { readFully } from './step-log';

test('a read that returns fewer bytes than asked keeps reading until the buffer is full', async () => {
  const file = Buffer.from('0123456789');
  const calls: number[] = [];
  const handle = {
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      calls.push(position);
      const bytesRead = Math.min(3, length, file.length - position);
      file.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead };
    },
  };
  const buffer = Buffer.alloc(8);
  expect((await readFully(handle, buffer, 2)).toString()).toBe('23456789');
  expect(calls).toEqual([2, 5, 8]);
});

test('a file that shrinks while it is read returns what was there', async () => {
  const file = Buffer.from('0123');
  const handle = {
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = Math.max(0, Math.min(length, file.length - position));
      file.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead };
    },
  };
  expect((await readFully(handle, Buffer.alloc(8), 0)).toString()).toBe('0123');
});
