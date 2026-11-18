import { expect, test } from 'bun:test';
import { finished } from 'node:stream/promises';

import { textSink } from './tart-cli';

test('a character split across two output chunks arrives whole', async () => {
  const texts: string[] = [];
  const sink = textSink((text) => texts.push(text));
  const bytes = new TextEncoder().encode('café ✓');
  sink.write(bytes.slice(0, 4));
  sink.write(bytes.slice(4, 8));
  sink.write(bytes.slice(8));
  await finished(sink.end());
  expect(texts.join('')).toBe('café ✓');
});
