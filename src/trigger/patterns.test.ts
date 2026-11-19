import { describe, expect, test } from 'bun:test';

import { TriggerError } from './errors';
import { matchesPatterns, matchesPattern } from './patterns';

describe('matchesPattern', () => {
  const cases: [string, string, boolean][] = [
    ['main', 'main', true],
    ['main', 'mainline', false],
    ['feature/*', 'feature/a', true],
    ['feature/*', 'feature/a/b', false],
    ['feature/**', 'feature/a/b', true],
    ['*', 'main', true],
    ['*', 'a/b', false],
    ['**', 'a/b/c', true],
    ['*feature', 'ver-10-feature', true],
    ['v2*', 'v2.9', true],
    ['*.js', 'app.js', true],
    ['*.js', 'src/app.js', false],
    ['**.js', 'src/js/app.js', true],
    ['docs/*', 'docs/a.md', true],
    ['docs/*', 'docs/a/b.md', false],
    ['docs/**/*.md', 'docs/a/b.md', true],
    ['**/README.md', 'README.md', true],
    ['**/README.md', 'js/README.md', true],
    ['*.jsx?', 'page.js', true],
    ['*.jsx?', 'page.jsx', true],
    ['*.jsx?', 'page.jsxx', false],
    ['ab+c', 'abbbc', true],
    ['ab+c', 'ac', false],
    ['v[12].[0-9]+.[0-9]+', 'v1.10.1', true],
    ['v[12].[0-9]+.[0-9]+', 'v3.0.0', false],
    ['[CB]at', 'Bat', true],
    ['[CB]at', 'Rat', false],
    ['[1-2]00', '200', true],
    ['release/v[0-9].[0-9]', 'release/v1.2', true],
    ['a.b', 'axb', false],
    [String.raw`a\*b`, 'a*b', true],
    [String.raw`a\*b`, 'aXb', false],
    ['Main', 'main', false],
    ['[0-9a-z]x', '7x', true],
    ['[0-9a-z]x', 'qx', true],
    ['[0-9a-z]x', 'Qx', false],
    [String.raw`a\[b`, 'a[b', true],
    // The cheat sheet's rows with a hyphen.
    ['feature/*', 'feature/my-branch', true],
    ['feature/**', 'feature/beta-a/my-branch', true],
    ['releases/mona-the-octocat', 'releases/mona-the-octocat', true],
    ['*feature', 'mona-feature', true],
    ['release-*', 'release-1', true],
    ['release-*', 'release_1', false],
    ['**/*src/**', 'my-src/code/js/app.js', true],
    ['**/*src/**', 'a/src/app.js', true],
    ['**/docs/**', 'dir/docs/my-file.txt', true],
    ['**/docs/**', 'space/docs/plan/space.doc', true],
    ['**/*-post.md', 'my-post.md', true],
    ['**/*-post.md', 'path/their-post.md', true],
    ['**/*-post.md', 'path/their_post.md', false],
    ['**/migrate-*.sql', 'migrate-10909.sql', true],
    ['**/migrate-*.sql', 'db/migrate-v1.0.sql', true],
    ['**/migrate-*.sql', 'db/sept/migrate-v1.sql', true],
    ['.github/workflows/ci-mac.yml', '.github/workflows/ci-mac.yml', true],
    // A quantifier with nothing before it is a literal character.
    ['?a', '?a', true],
    ['?a', 'a', false],
    ['+a', '+a', true],
    ['+a', 'a', false],
    // A quantifier after a wildcard changes nothing.
    ['a*+', 'abc', true],
    ['a*?', 'a/b', false],
    // Names are compared by code point.
    ['docs/🚀.md', 'docs/🚀.md', true],
    ['a🚀+b', 'a🚀🚀b', true],
    ['a🚀?b', 'ab', true],
    ['*', '🚀', true],
    ['?', '🚀', false],
    // Git allows a line break in a path; `*` crosses it but never `/`.
    ['*', 'a\nb', true],
    ['docs/*', 'docs/a\nb.md', true],
    ['*', 'a\n/b', false],
    ['**', 'a\n/b', true],
  ];
  test.each(cases)('%s vs %s is %p', (pattern, name, expected) => {
    expect(matchesPattern(pattern, name)).toBe(expected);
  });
});

describe('a pattern GitHub would not parse', () => {
  const cases: [string, string][] = [
    ['empty class', '[]'],
    ['class of a bracket', '[]]'],
    ['unterminated class', '[unclosed'],
    ['negated class', '[^a]'],
    ['escape in a class', String.raw`[a\]]`],
    ['reversed range', '[z-a]'],
    ['range across kinds', '[a-Z]'],
    ['range across digits and letters', '[0-z]'],
    ['dangling hyphen', '[a-]'],
    ['leading hyphen', '[-a]'],
    ['punctuation in a class', '[a.]'],
    ['non-ASCII letter in a class', '[é]'],
  ];
  test.each(cases)('%s is a TriggerError', (_, pattern) => {
    expect(() => matchesPattern(pattern, 'a')).toThrow(TriggerError);
  });
});

describe('matching time', () => {
  // A backtracking matcher takes seconds to minutes on these; each must stay linear in the name.
  const cases: [string, string][] = [
    ['**a**a**a**a**a**a**b', 'a'.repeat(80)],
    ['**?*?*?*?*?*?x', 'a'.repeat(200)],
    ['a+a+a+a+a+a+a+a+b', 'a'.repeat(2000)],
    [`${'**a'.repeat(40)}b`, 'a'.repeat(5000)],
    [`${'*/'.repeat(30)}x`, 'a/'.repeat(3000)],
  ];
  test('adversarial patterns finish well under a second', () => {
    const started = performance.now();
    for (const [pattern, name] of cases) {
      expect(matchesPattern(pattern, name)).toBe(false);
    }
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('matchesPatterns', () => {
  const cases: [string, string[], string, boolean][] = [
    ['one positive', ['main'], 'main', true],
    ['no positive matches', ['main'], 'dev', false],
    ['later negation excludes', ['*.md', '!README.md'], 'README.md', false],
    ['negation leaves others', ['*.md', '!README.md'], 'hello.md', true],
    ['later positive re-includes', ['*.md', '!README.md', 'README*'], 'README.md', true],
    ['negation alone cannot add', ['!README.md', 'other'], 'README.md', false],
    ['negation before positive does not exclude', ['!a', 'a'], 'a', true],
    ['bang mid-pattern is literal', ['a!b'], 'a!b', true],
  ];
  test.each(cases)('%s', (_, patterns, name, expected) => {
    expect(matchesPatterns(patterns, name)).toBe(expected);
  });
});
