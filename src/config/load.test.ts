import { expect, test } from 'bun:test';

import { resolveConfigPath } from '../source/locations';
import { loadConfig } from './load';
import type { ReadText } from './load';
import { ConfigError } from './schema';

const reading =
  (text: string): ReadText =>
  async () =>
    text;

const failing =
  (code: string): ReadText =>
  async () => {
    throw Object.assign(new Error(`read failed: ${code}`), { code });
  };

/** The message of the ConfigError loading `path` raises; fails the test when it raises none. */
async function refusal(path: string, readText: ReadText): Promise<string> {
  try {
    await loadConfig(path, readText);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.message;
    }
    throw error;
  }
  throw new Error('the configuration loaded');
}

test('loads and validates the file at the path', async () => {
  const config = await loadConfig('/c.yaml', reading('repositories: [a/b]\nallowlist: [x]\n'));
  expect(config.repositories).toEqual(['a/b']);
  expect(config.allowlist).toEqual(['x']);
});

test('a missing file names the path tried and how to point Hugi at a configuration', async () => {
  const message = await refusal('/missing/config.yaml', failing('ENOENT'));
  expect(message).toContain('/missing/config.yaml');
  expect(message).toContain('--config');
  expect(message).toContain('HUGI_CONFIG');
});

test('an unreadable file is a ConfigError naming the path', async () => {
  expect(await refusal('/c.yaml', failing('EACCES'))).toContain(
    'Cannot read the configuration file /c.yaml',
  );
});

test('a YAML refusal surfaces with its location', async () => {
  expect(await refusal('/c.yaml', reading('a: 1\na: 2\n'))).toMatch(
    /^\/c\.yaml: .*line 2, column \d+/u,
  );
});

test('a refusal is prefixed with the path', async () => {
  expect(await refusal('/c.yaml', reading('lanes: []\n'))).toContain(
    '/c.yaml: lanes: is not a known key',
  );
});

test('an empty file is not a mapping', async () => {
  expect(await refusal('/c.yaml', reading(''))).toContain('must be a mapping');
});

test('the path is the flag, then HUGI_CONFIG, then the XDG config home, then ~/.config', () => {
  const env = { HUGI_CONFIG: '/env.yaml', XDG_CONFIG_HOME: '/xdg' };
  expect(resolveConfigPath('/flag.yaml', env, '/home/u')).toBe('/flag.yaml');
  expect(resolveConfigPath(undefined, env, '/home/u')).toBe('/env.yaml');
  expect(resolveConfigPath(undefined, { XDG_CONFIG_HOME: '/xdg' }, '/home/u')).toBe(
    '/xdg/hugi/config.yaml',
  );
  expect(resolveConfigPath(undefined, {}, '/home/u')).toBe('/home/u/.config/hugi/config.yaml');
  expect(resolveConfigPath('', { HUGI_CONFIG: '' }, '/home/u')).toBe(
    '/home/u/.config/hugi/config.yaml',
  );
});
