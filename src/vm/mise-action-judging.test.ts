import { describe, expect, test } from 'bun:test';

import {
  exportedVariables,
  hasLockFile,
  lockFilePlaces,
  managedPaths,
  orderedWorkflowBins,
  overlapConflicts,
  miseVersion,
  parseProbe,
  setsMonorepoRoots,
} from './mise-action-judging';
import type { LockFilePlace } from './mise-action-judging';
import { ToolOutputError } from './tool-environment';

const WORKSPACE = '/Users/admin/hugi/workspace';

/**
 * The lock file listing of `places`, one line each, none holding a regular file but `path`, which
 * holds `files`; a `path` that is not one of the places gets a line of its own at the end.
 */
const listing = (places: readonly LockFilePlace[], path: string, files: string[]) =>
  [
    ...places.map((place) => ({ files: place.path === path ? files : [], path: place.path })),
    ...(places.some((place) => place.path === path) ? [] : [{ files, path }]),
  ]
    .map((record) => `${JSON.stringify(record)}\n`)
    .join('');

const entry = (role: string, dir: string, executables: string[], real = dir) =>
  JSON.stringify({ dir, executables, real, role });
const lines = (...entries: string[]) => `${entries.join('\n')}\n`;
const probe = (onPath: boolean) =>
  JSON.stringify({
    dataDir: '/Users/admin/.local/share/mise',
    onPath,
    supports: { envJson: true, envPaths: true, installLocked: false },
  });

describe('the lock file search', () => {
  test('climbs from the working directory to the workspace root and no further', () => {
    const paths = lockFilePlaces('a/b').map((place) => place.path);
    expect(paths.filter((path) => !/\/\.?(?:config|mise)$/u.test(path))).toEqual([
      `${WORKSPACE}/a/b`,
      `${WORKSPACE}/a`,
      WORKSPACE,
    ]);
    expect(paths.every((path) => path.startsWith(WORKSPACE))).toBe(true);
  });

  test.each([
    ['mise', '/mise', ['.mise.lock', 'config.lock']],
    ['.mise', '/.mise', ['.mise.lock', 'config.lock']],
    ['.config/mise', '/.config/mise', ['.mise.lock', 'config.lock']],
    ['.config', '/.config', ['.mise.lock', 'mise.lock']],
  ])(
    'with working directory %s, a directory two searches share is one place with the names of both',
    (workingDirectory, place, names) => {
      const places = lockFilePlaces(workingDirectory);
      const paths = places.map((each) => each.path);
      expect(new Set(paths).size).toBe(paths.length);
      const shared = places.find((each) => each.path === `${WORKSPACE}${place}`);
      for (const name of names) {
        expect(shared?.patterns.some((pattern) => pattern.test(name))).toBe(true);
      }
    },
  );

  test.each([
    ['mise', '/mise', 'config.lock'],
    ['.mise', '/.mise', 'config.lock'],
    ['.config/mise', '/.config/mise', 'config.lock'],
    ['.config', '/.config', '.mise.lock'],
  ])(
    'with working directory %s, a place two searches share counts the names of both',
    (workingDirectory, place, file) => {
      const places = lockFilePlaces(workingDirectory);
      expect(hasLockFile(places, listing(places, `${WORKSPACE}${place}`, [file]))).toBe(true);
    },
  );

  test('searches the places the action searches in each directory', () => {
    expect(lockFilePlaces(undefined).map((place) => place.path)).toEqual([
      WORKSPACE,
      `${WORKSPACE}/.config`,
      `${WORKSPACE}/.config/mise`,
      `${WORKSPACE}/.mise`,
      `${WORKSPACE}/mise`,
    ]);
  });

  test.each([
    ['', 'mise.lock'],
    ['', '.mise.lock'],
    ['', 'mise.ci.lock'],
    ['', '.mise.local.lock'],
    ['/.config', 'mise.lock'],
    ['/.config', 'mise.ci.lock'],
    ['/.config/mise', 'config.lock'],
    ['/.config/mise', 'config.ci.lock'],
    ['/.config/mise', 'mise.lock'],
    ['/.mise', 'config.lock'],
    ['/.mise', '.mise.lock'],
    ['/mise', 'config.lock'],
  ])('finds %s/%s', (place, file) => {
    const places = lockFilePlaces(undefined);
    expect(hasLockFile(places, listing(places, `${WORKSPACE}${place}`, [file]))).toBe(true);
  });

  test.each([
    ['', 'config.lock'],
    ['', 'mise.a.b.lock'],
    ['', 'mise.lock.bak'],
    ['/.config', '.mise.lock'],
    ['/.config', 'config.lock'],
    ['/other', 'mise.lock'],
  ])('does not count %s/%s', (place, file) => {
    const places = lockFilePlaces(undefined);
    expect(hasLockFile(places, listing(places, `${WORKSPACE}${place}`, [file]))).toBe(false);
  });

  test('a monorepo line says whether the config sets monorepo.config_roots', () => {
    const listingText = listing(lockFilePlaces(undefined), WORKSPACE, ['mise.toml']);
    expect(setsMonorepoRoots(`${listingText}{"monorepo":true}\n`)).toBe(true);
    expect(setsMonorepoRoots(`${listingText}{"monorepo":false}\n`)).toBe(false);
    expect(setsMonorepoRoots(listingText)).toBe(false);
  });

  test('counts a lock file in an ancestor of the working directory inside the workspace', () => {
    const places = lockFilePlaces('pkg/app');
    expect(hasLockFile(places, listing(places, `${WORKSPACE}/pkg`, ['mise.lock']))).toBe(true);
    expect(hasLockFile(places, listing(places, '/Users/admin/hugi', ['mise.lock']))).toBe(false);
  });

  test('a listing without a readable line for every place it searched is a ToolOutputError', () => {
    const places = lockFilePlaces(undefined);
    const rest = listing(places.slice(1), `${WORKSPACE}/other`, []);
    expect(() => hasLockFile(places, '')).toThrow(ToolOutputError);
    expect(() => hasLockFile(places, rest)).toThrow(new RegExp(`no line for ${WORKSPACE}$`, 'u'));
    expect(() =>
      hasLockFile(places, listing(places.slice(0, -1), WORKSPACE, ['mise.lock'])),
    ).toThrow(`no line for ${WORKSPACE}/mise`);
    const unreadable = `${JSON.stringify({ files: [1], path: WORKSPACE })}\n`;
    expect(() => hasLockFile(places, `${unreadable}${rest}`)).toThrow(ToolOutputError);
  });

  test('a listing with two lines for one directory is a ToolOutputError, whichever holds the lock file', () => {
    const places = lockFilePlaces(undefined);
    const once = listing(places, WORKSPACE, ['mise.lock']);
    const again = `${JSON.stringify({ files: [], path: WORKSPACE })}\n`;
    expect(() => hasLockFile(places, `${once}${again}`)).toThrow(`lists ${WORKSPACE} twice`);
    expect(() => hasLockFile(places, `${again}${once}`)).toThrow(`lists ${WORKSPACE} twice`);
  });
});

describe('the overlap check', () => {
  test('passes when the config and a workflow tool share one directory after resolving links', () => {
    const text = lines(
      entry('config', '/data/installs/node/22.23.2/bin', ['node', 'npm']),
      entry(
        'workflow',
        '/data/installs/node/22/bin',
        ['node', 'npm'],
        '/data/installs/node/22.23.2/bin',
      ),
    );
    expect(overlapConflicts(text)).toEqual([]);
  });

  test('fails for an executable in a config directory and a different workflow directory, naming both', () => {
    const text = lines(
      entry('config', '/data/installs/npm-pnpm/10/bin', ['pnpm', 'pnpx']),
      entry('config', '/repo/bin', ['lint']),
      entry('workflow', '/data/installs/pnpm/10.1.0/bin', ['pnpm']),
    );
    const conflicts = overlapConflicts(text);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('pnpm');
    expect(conflicts[0]).toContain('/data/installs/npm-pnpm/10/bin');
    expect(conflicts[0]).toContain('/data/installs/pnpm/10.1.0/bin');
  });

  test('ignores executables only one side has', () => {
    const text = lines(entry('config', '/cfg/bin', ['nu']), entry('workflow', '/wf/bin', ['node']));
    expect(overlapConflicts(text)).toEqual([]);
  });

  test('output it cannot read is a ToolOutputError', () => {
    expect(() => overlapConflicts('not json\n')).toThrow(ToolOutputError);
    expect(() => overlapConflicts(`${JSON.stringify({ role: 'config' })}\n`)).toThrow(
      ToolOutputError,
    );
  });
});

describe('what the step exports', () => {
  test('every variable mise env prints except PATH, in any case, and only text values', () => {
    const json = JSON.stringify({
      FOO: 'a\nb',
      NUM: 1,
      PATH: '/y',
      Path: '/x',
      RUSTUP_TOOLCHAIN: '1.97.1',
    });
    expect(exportedVariables(json)).toEqual({ FOO: 'a\nb', RUSTUP_TOOLCHAIN: '1.97.1' });
  });

  test('a name a shell cannot export is a ToolOutputError naming it', () => {
    expect(() => exportedVariables(JSON.stringify({ 'A-B': 'x' }))).toThrow('"A-B"');
  });

  test('managed paths keep their order and drop empty lines', () => {
    expect(managedPaths('/a\n\n/b\r\n')).toEqual(['/a', '/b']);
  });
});

describe('the probe', () => {
  test('keeps the data directory, whether mise is on PATH, and the capabilities', () => {
    for (const onPath of [true, false]) {
      expect(parseProbe(probe(onPath))).toEqual({
        dataDir: '/Users/admin/.local/share/mise',
        onPath,
        supports: { envJson: true, envPaths: true, installLocked: false },
      });
    }
  });

  test('output of another shape is a ToolOutputError', () => {
    expect(() => parseProbe('{}')).toThrow(ToolOutputError);
    expect(() => parseProbe(JSON.stringify({ ...JSON.parse(probe(true)), onPath: 'yes' }))).toThrow(
      ToolOutputError,
    );
  });
});

describe("the guest's mise version", () => {
  test('is the first word of the first line, without a leading v', () => {
    expect(miseVersion('2026.11.12 macos-arm64 (2026-11-21)\n')).toBe('2026.11.12');
    expect(miseVersion('\nv2026.1.0 linux-x64')).toBe('2026.1.0');
  });

  test('output without one is a ToolOutputError', () => {
    for (const text of ['', '\n', '  \n', 'v']) {
      expect(() => miseVersion(text)).toThrow('mise --version printed no version');
    }
  });
});

test('workflow bins follow the tool environment order, then their own', () => {
  const bins = ['/n/bin', '/z/bin', '/r/bin'];
  expect(orderedWorkflowBins(bins, '/r/bin:/x:/n/bin:/usr/bin')).toEqual([
    '/r/bin',
    '/n/bin',
    '/z/bin',
  ]);
  expect(orderedWorkflowBins(bins, undefined)).toEqual(bins);
});
