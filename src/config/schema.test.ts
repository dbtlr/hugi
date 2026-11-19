import { expect, test } from 'bun:test';

import { ConfigError, validateConfig } from './schema';

const MINIMAL = { allowlist: [], repositories: ['dbtlr/hugi'] };

test('a minimal configuration gets the defaults', () => {
  expect(validateConfig(MINIMAL)).toEqual({
    allowlist: [],
    pollIntervalSeconds: 60,
    repositories: ['dbtlr/hugi'],
    vm: { cpus: 4, memoryGb: 4 },
  });
});

test('a full configuration is read as written', () => {
  const config = validateConfig({
    allowlist: ['dbtlr', 'a-b-1'],
    poll_interval: 15,
    repositories: ['dbtlr/hugi', 'dbtlr/norn.git-x', 'Org-1/some_repo'],
    vm: { cpus: 16, memory_gb: 64 },
  });
  expect(config).toEqual({
    allowlist: ['dbtlr', 'a-b-1'],
    pollIntervalSeconds: 15,
    repositories: ['dbtlr/hugi', 'dbtlr/norn.git-x', 'Org-1/some_repo'],
    vm: { cpus: 16, memoryGb: 64 },
  });
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
});

const refusals: readonly [string, unknown, string][] = [
  ['a null document', null, 'configuration: must be a mapping'],
  ['a list document', [], 'configuration: must be a mapping'],
  ['a string document', 'hi', 'configuration: must be a mapping'],
  ['an unknown key', { ...MINIMAL, extra: 1 }, 'extra: is not a known key'],
  ['a lanes key', { ...MINIMAL, lanes: ['ci.yml:build'] }, 'lanes: is not a known key'],
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
];

test.each(refusals)('refuses %s', (_name, input, message) => {
  expect(() => validateConfig(input)).toThrow(ConfigError);
  expect(() => validateConfig(input)).toThrow(message);
});
