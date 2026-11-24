import { expect, test } from 'bun:test';

import { ConfigError, validateConfig } from './schema';

const MINIMAL = { allowlist: [], repositories: ['dbtlr/hugi'] };

test('a minimal configuration gets the defaults', () => {
  expect(validateConfig(MINIMAL)).toEqual({
    allowlist: [],
    pollIntervalSeconds: 60,
    repositories: ['dbtlr/hugi'],
    runs: { maxAgeDays: 30, maxSizeGb: 5 },
    vm: { cpus: 4, memoryGb: 4 },
  });
});

test('a full configuration is read as written', () => {
  const config = validateConfig({
    allowlist: ['dbtlr', 'a-b-1'],
    poll_interval: 15,
    repositories: ['dbtlr/hugi', 'dbtlr/norn.git-x', 'Org-1/some_repo'],
    runs: { max_age_days: 7, max_size_gb: 20 },
    vm: { cpus: 16, memory_gb: 64 },
  });
  expect(config).toEqual({
    allowlist: ['dbtlr', 'a-b-1'],
    pollIntervalSeconds: 15,
    repositories: ['dbtlr/hugi', 'dbtlr/norn.git-x', 'Org-1/some_repo'],
    runs: { maxAgeDays: 7, maxSizeGb: 20 },
    vm: { cpus: 16, memoryGb: 64 },
  });
});

test('a runs mapping may set one key and default the other', () => {
  expect(validateConfig({ ...MINIMAL, runs: { max_size_gb: 1 } }).runs).toEqual({
    maxAgeDays: 30,
    maxSizeGb: 1,
  });
  expect(validateConfig({ ...MINIMAL, runs: {} }).runs).toEqual({ maxAgeDays: 30, maxSizeGb: 5 });
});

test('an Enterprise Managed User login is admitted', () => {
  expect(validateConfig({ ...MINIMAL, allowlist: ['jdoe_acme'] }).allowlist).toEqual(['jdoe_acme']);
});

test('a repository name of 100 characters is admitted', () => {
  const name = `a/${'b'.repeat(100)}`;
  expect(validateConfig({ ...MINIMAL, repositories: [name] }).repositories).toEqual([name]);
});

test('the result is frozen', () => {
  const config = validateConfig(MINIMAL);
  expect(Object.isFrozen(config)).toBe(true);
  expect(Object.isFrozen(config.repositories)).toBe(true);
  expect(Object.isFrozen(config.allowlist)).toBe(true);
  expect(Object.isFrozen(config.vm)).toBe(true);
  expect(Object.isFrozen(config.runs)).toBe(true);
});

test('a github_app is read, its key path as written', () => {
  const config = validateConfig({
    ...MINIMAL,
    github_app: { app_id: 12345, private_key_path: '~/.config/hugi/app.pem' },
  });
  expect(config.githubApp).toEqual({ appId: 12345, privateKeyPath: '~/.config/hugi/app.pem' });
  expect(Object.isFrozen(config.githubApp)).toBe(true);
});

test('without a github_app the configuration has none', () => {
  expect('githubApp' in validateConfig(MINIMAL)).toBe(false);
});

const GITHUB_APP = { app_id: 1, private_key_path: '/keys/app.pem' };

const refusals: readonly [string, unknown, string][] = [
  ['a null document', null, 'configuration: must be a mapping'],
  ['a list document', [], 'configuration: must be a mapping'],
  ['a string document', 'hi', 'configuration: must be a mapping'],
  ['an unknown key', { ...MINIMAL, extra: 1 }, 'extra: is not a known key'],
  ['a lanes key', { ...MINIMAL, lanes: ['ci.yml:build'] }, 'lanes: is not a known key'],
  [
    'a path key, which the service unit replaced',
    { ...MINIMAL, path: ['/bin'] },
    'path: is not a known key',
  ],
  ['no repositories', { allowlist: [] }, 'repositories: is required'],
  ['empty repositories', { ...MINIMAL, repositories: [] }, 'repositories: must list at least one'],
  ['repositories not a list', { ...MINIMAL, repositories: 'a/b' }, 'repositories: must be a list'],
  [
    'a repository without a slash',
    { ...MINIMAL, repositories: ['a/b', 'c/d', 'hugi'] },
    'repositories[2]: must be a GitHub repository as owner/name',
  ],
  ['a repository of three parts', { ...MINIMAL, repositories: ['a/b/c'] }, 'repositories[0]'],
  ['a repository named ..', { ...MINIMAL, repositories: ['a/..'] }, 'repositories[0]'],
  ['a repository with a bad owner', { ...MINIMAL, repositories: ['-a/b'] }, 'repositories[0]'],
  ['a repository that is a number', { ...MINIMAL, repositories: [3] }, 'repositories[0]'],
  [
    'a repeated repository, case-insensitively',
    { ...MINIMAL, repositories: ['Dbtlr/Hugi', 'x/y', 'dbtlr/hugi'] },
    'repositories[2]: repeats repositories[0]',
  ],
  ['no allowlist', { repositories: ['a/b'] }, 'allowlist: is required'],
  [
    'an allowlist that is not a list',
    { ...MINIMAL, allowlist: 'dbtlr' },
    'allowlist: must be a list',
  ],
  ['a login with a leading hyphen', { ...MINIMAL, allowlist: ['-a'] }, 'allowlist[0]'],
  ['a login with a trailing hyphen', { ...MINIMAL, allowlist: ['a-'] }, 'allowlist[0]'],
  ['a login with a double hyphen', { ...MINIMAL, allowlist: ['a--b'] }, 'allowlist[0]'],
  ['a login with a leading underscore', { ...MINIMAL, allowlist: ['_a'] }, 'allowlist[0]'],
  ['a login with a double underscore', { ...MINIMAL, allowlist: ['a__b'] }, 'allowlist[0]'],
  ['a login over 39 characters', { ...MINIMAL, allowlist: ['a'.repeat(40)] }, 'allowlist[0]'],
  ['an empty login', { ...MINIMAL, allowlist: [''] }, 'allowlist[0]'],
  [
    'a repository name over 100 characters',
    { ...MINIMAL, repositories: [`a/${'b'.repeat(101)}`] },
    'repositories[0]',
  ],
  [
    'a repeated login, case-insensitively',
    { ...MINIMAL, allowlist: ['ok', 'Drew', 'DREW'] },
    'allowlist[2]: repeats allowlist[1]',
  ],
  [
    'a string poll_interval',
    { ...MINIMAL, poll_interval: '60' },
    'poll_interval: must be an integer',
  ],
  [
    'a fractional poll_interval',
    { ...MINIMAL, poll_interval: 20.5 },
    'poll_interval: must be an integer',
  ],
  [
    'a poll_interval under 15',
    { ...MINIMAL, poll_interval: 14 },
    'poll_interval: must be between 15 and 3600',
  ],
  [
    'a poll_interval over 3600',
    { ...MINIMAL, poll_interval: 3601 },
    'poll_interval: must be between 15 and 3600',
  ],
  ['a github_app that is a list', { ...MINIMAL, github_app: [] }, 'github_app: must be a mapping'],
  [
    'an unknown github_app key',
    { ...MINIMAL, github_app: { ...GITHUB_APP, secret: 'x' } },
    'github_app.secret: is not a known key',
  ],
  [
    'a github_app without an app_id',
    { ...MINIMAL, github_app: { private_key_path: '/k.pem' } },
    'github_app.app_id: is required',
  ],
  [
    'a string app_id',
    { ...MINIMAL, github_app: { ...GITHUB_APP, app_id: '12' } },
    'github_app.app_id: must be an integer',
  ],
  [
    'a zero app_id',
    { ...MINIMAL, github_app: { ...GITHUB_APP, app_id: 0 } },
    'github_app.app_id: must be between',
  ],
  [
    'a github_app without a key path',
    { ...MINIMAL, github_app: { app_id: 1 } },
    'github_app.private_key_path: is required',
  ],
  [
    'a relative key path',
    { ...MINIMAL, github_app: { ...GITHUB_APP, private_key_path: 'app.pem' } },
    'github_app.private_key_path: must be a file path that is absolute or starts with ~/',
  ],
  [
    'a key path that is a directory',
    { ...MINIMAL, github_app: { ...GITHUB_APP, private_key_path: '/keys/' } },
    'github_app.private_key_path',
  ],
  ['a vm that is not a mapping', { ...MINIMAL, vm: 4 }, 'vm: must be a mapping'],
  ['an unknown vm key', { ...MINIMAL, vm: { disk: 50 } }, 'vm.disk: is not a known key'],
  ['string vm cpus', { ...MINIMAL, vm: { cpus: '4' } }, 'vm.cpus: must be an integer'],
  ['zero vm cpus', { ...MINIMAL, vm: { cpus: 0 } }, 'vm.cpus: must be between 1 and 16'],
  ['17 vm cpus', { ...MINIMAL, vm: { cpus: 17 } }, 'vm.cpus: must be between 1 and 16'],
  [
    'fractional vm memory',
    { ...MINIMAL, vm: { memory_gb: 2.5 } },
    'vm.memory_gb: must be an integer',
  ],
  [
    '1 GB of vm memory',
    { ...MINIMAL, vm: { memory_gb: 1 } },
    'vm.memory_gb: must be between 2 and 64',
  ],
  [
    '65 GB of vm memory',
    { ...MINIMAL, vm: { memory_gb: 65 } },
    'vm.memory_gb: must be between 2 and 64',
  ],
  ['a runs that is not a mapping', { ...MINIMAL, runs: 4 }, 'runs: must be a mapping'],
  ['an unknown runs key', { ...MINIMAL, runs: { keep: 3 } }, 'runs.keep: is not a known key'],
  [
    'string max_age_days',
    { ...MINIMAL, runs: { max_age_days: '30' } },
    'runs.max_age_days: must be an integer',
  ],
  [
    'zero max_age_days',
    { ...MINIMAL, runs: { max_age_days: 0 } },
    'runs.max_age_days: must be between 1 and 3650',
  ],
  [
    'fractional max_size_gb',
    { ...MINIMAL, runs: { max_size_gb: 0.5 } },
    'runs.max_size_gb: must be an integer',
  ],
  [
    'negative max_size_gb',
    { ...MINIMAL, runs: { max_size_gb: -1 } },
    'runs.max_size_gb: must be between 1 and 100000',
  ],
];

test.each(refusals)('refuses %s', (_name, input, message) => {
  expect(() => validateConfig(input)).toThrow(ConfigError);
  expect(() => validateConfig(input)).toThrow(message);
});

const WEB = { port: 8470, url: 'https://hugi.example.ts.net' };

test('a web block is read, its url as an origin', () => {
  expect(validateConfig({ ...MINIMAL, web: WEB }).web).toEqual({
    port: 8470,
    url: 'https://hugi.example.ts.net',
  });
});

test('without web the configuration has none', () => {
  expect('web' in validateConfig(MINIMAL)).toBe(false);
});

test.each([
  [
    'a lone trailing slash is dropped',
    'https://hugi.example.ts.net/',
    'https://hugi.example.ts.net',
  ],
  ['an http origin with a port is kept', 'http://valhalla:8470', 'http://valhalla:8470'],
  ['an upper-case host is lowered', 'https://Hugi.Example.TS.net', 'https://hugi.example.ts.net'],
  ['an IPv6 host is kept', 'http://[::1]:9000', 'http://[::1]:9000'],
  ['an upper-case scheme is lowered', 'HTTPS://hugi.example.ts.net', 'https://hugi.example.ts.net'],
])('web.url: %s', (_name, url, origin) => {
  expect(validateConfig({ ...MINIMAL, web: { port: 8470, url } }).web?.url).toBe(origin);
});

test.each([1024, 65_535])('web.port %d is admitted', (port) => {
  expect(validateConfig({ ...MINIMAL, web: { ...WEB, port } }).web?.port).toBe(port);
});

const webRefusals: readonly [string, unknown, string][] = [
  ['a web that is not a mapping', 'https://x', 'web: must be a mapping'],
  ['an unknown web key', { ...WEB, host: '0.0.0.0' }, 'web.host: is not a known key'],
  ['a web without a port', { url: WEB.url }, 'web.port: is required'],
  ['a web without a url', { port: 8470 }, 'web.url: is required'],
  ['a port under 1024', { ...WEB, port: 1023 }, 'web.port: must be between 1024 and 65535'],
  ['a port over 65535', { ...WEB, port: 65_536 }, 'web.port: must be between 1024 and 65535'],
  ['a string port', { ...WEB, port: '8470' }, 'web.port: must be an integer'],
  ['a url that is not a string', { ...WEB, url: 8470 }, 'web.url: must be an http or https origin'],
  ['a url that does not parse', { ...WEB, url: 'not a url' }, 'web.url: must be an http or https'],
  ['a url with another scheme', { ...WEB, url: 'ftp://hugi.example' }, 'web.url: must be an http'],
  ['a url with a path', { ...WEB, url: 'https://x.example/hugi' }, 'web.url: must have no path'],
  [
    'a url with a deeper path',
    { ...WEB, url: 'https://x.example/a/' },
    'web.url: must have no path',
  ],
  [
    'a url with two trailing slashes',
    { ...WEB, url: 'https://x.example//' },
    'web.url: must have no path',
  ],
  ['a url with a query', { ...WEB, url: 'https://x.example?a=1' }, 'web.url: must have no query'],
  [
    'a url with an empty query',
    { ...WEB, url: 'https://x.example/?' },
    'web.url: must have no query',
  ],
  [
    'a url with a fragment',
    { ...WEB, url: 'https://x.example#top' },
    'web.url: must have no fragment',
  ],
  [
    'a url with a user',
    { ...WEB, url: 'https://me@x.example' },
    'web.url: must have no credentials',
  ],
  [
    'a url with a password',
    { ...WEB, url: 'https://me:pw@x.example' },
    'web.url: must have no credentials',
  ],
  [
    'a url a backslash would cut short',
    { ...WEB, url: 'https://x.example\\evil' },
    'web.url: must be written as the origin it names',
  ],
  [
    'a url whose IPv4 host would be rewritten',
    { ...WEB, url: 'https://1.2.3' },
    'web.url: must be written as the origin it names',
  ],
  ['a url with port 0', { ...WEB, url: 'https://x.example:0' }, 'web.url: must not have port 0'],
  [
    'a url with the default https port',
    { ...WEB, url: 'https://x.example:443' },
    'web.url: must not name the default port',
  ],
  [
    'a url with the default http port',
    { ...WEB, url: 'http://x.example:80/' },
    'web.url: must not name the default port',
  ],
];

test.each(webRefusals)('refuses %s', (_name, web, message) => {
  expect(() => validateConfig({ ...MINIMAL, web })).toThrow(ConfigError);
  expect(() => validateConfig({ ...MINIMAL, web })).toThrow(message);
});
