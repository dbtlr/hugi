import { expect, test } from 'bun:test';

import { parseRepository, repositoryLabel, RepositorySpecError } from './repository-spec';

const parse = (text: string) => parseRepository(text, '/work/here', '/home/u');

test('owner/name is a public GitHub repository cloned over HTTPS', () => {
  expect(parse('dbtlr/norn-next')).toEqual({
    cloneUrl: 'https://github.com/dbtlr/norn-next.git',
    kind: 'github',
    name: 'dbtlr/norn-next',
  });
});

test('explicit paths are local, resolved against the working directory and home', () => {
  expect(parse('./repo')).toEqual({ kind: 'local', path: '/work/here/repo' });
  expect(parse('../repo')).toEqual({ kind: 'local', path: '/work/repo' });
  expect(parse('/abs/repo')).toEqual({ kind: 'local', path: '/abs/repo' });
  expect(parse('~/repo')).toEqual({ kind: 'local', path: '/home/u/repo' });
});

test('an ambiguous bare word is refused', () => {
  expect(() => parse('hugi')).toThrow(RepositorySpecError);
});

test('the label is the GitHub name, or local/<directory>', () => {
  expect(repositoryLabel(parse('dbtlr/hugi'))).toBe('dbtlr/hugi');
  expect(repositoryLabel(parse('/abs/repo'))).toBe('local/repo');
});

test('owner/name.git names the same repository as owner/name', () => {
  expect(parse('dbtlr/norn-next.git')).toEqual(parse('dbtlr/norn-next'));
});
