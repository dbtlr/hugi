import { describe, expect, test } from 'bun:test';

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
    ['[unclosed', '[unclosed', true],
  ];
  test.each(cases)('%s vs %s is %p', (pattern, name, expected) => {
    expect(matchesPattern(pattern, name)).toBe(expected);
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
