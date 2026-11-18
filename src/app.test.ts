import { expect, test } from 'bun:test';

import { mockProcess } from '@loomcli/testing';

import pkg from '../package.json' with { type: 'json' };
import { createApp } from './app';

test('--version prints the package version', async () => {
  const mock = mockProcess({ argv: ['--version'], env: {}, stdin: '' }),
    exitCode = await createApp().run({ process: mock });
  expect(exitCode).toBe(0);
  expect(mock.stdout.text.trim()).toBe(pkg.version);
});

test('--help works without any command declared', async () => {
  const mock = mockProcess({ argv: ['--help'], env: {}, stdin: '' }),
    exitCode = await createApp().run({ process: mock });
  expect(exitCode).toBe(0);
  expect(mock.stdout.text).toContain('hugi');
});
