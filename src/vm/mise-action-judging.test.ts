import { describe, expect, test } from 'bun:test';

import {
  exportedVariables,
  hasLockFile,
  lockFilePlaces,
  managedPaths,
  orderedWorkflowBins,
  overlapConflicts,
  parseProbe,
  setsMonorepoRoots,
} from './mise-action-judging';
import { ToolOutputError } from './tool-environment';

const WORKSPACE = '/Users/admin/hugi/workspace';

/** One line of the lock file listing: a place and its regular files. */
const listing = (path: string, files: string[]) => `${JSON.stringify({ files, path })}\n`;

const entry = (role: string, dir: string, executables: string[], real = dir) =>
  JSON.stringify({ dir, executables, real, role });
const lines = (...entries: string[]) => `${entries.join('\n')}\n`;
const probe = (version: string) =>
  JSON.stringify({
    dataDir: '/Users/admin/.local/share/mise',
    supports: { envJson: true, envPaths: true, installLocked: false },
    version,
    workflowBins: ['/wf/node/bin'],
  });

describe('the lock file search', () => {
  test('climbs from the working directory to the workspace root and no further', () => {
    const dirs = [...new Set(lockFilePlaces('a/b').map((place) => place.dir))];
    expect(dirs).toEqual([`${WORKSPACE}/a/b`, `${WORKSPACE}/a`, WORKSPACE]);
    expect(lockFilePlaces(undefined).every((place) => place.dir === WORKSPACE)).toBe(true);
  });

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
    expect(hasLockFile(places, listing(`${WORKSPACE}${place}`, [file]))).toBe(true);
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
    expect(hasLockFile(places, listing(`${WORKSPACE}${place}`, [file]))).toBe(false);
  });

  test('a monorepo line says whether the config sets monorepo.config_roots', () => {
    const listingText = listing(WORKSPACE, ['mise.toml']);
    expect(setsMonorepoRoots(`${listingText}{"monorepo":true}\n`)).toBe(true);
    expect(setsMonorepoRoots(`${listingText}{"monorepo":false}\n`)).toBe(false);
    expect(setsMonorepoRoots(listingText)).toBe(false);
  });

  test('counts a lock file in an ancestor of the working directory inside the workspace', () => {
    const places = lockFilePlaces('pkg/app');
    expect(hasLockFile(places, listing(`${WORKSPACE}/pkg`, ['mise.lock']))).toBe(true);
    expect(hasLockFile(places, listing('/Users/admin/hugi', ['mise.lock']))).toBe(false);
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
  test('reads the version from the first line, without a leading v', () => {
    expect(parseProbe(probe('2026.11.12 macos-arm64 (2026-11-21)\n')).version).toBe('2026.11.12');
    expect(parseProbe(probe('v2026.1.0 linux-x64')).version).toBe('2026.1.0');
  });

  test('keeps the data directory, the capabilities and the workflow bins', () => {
    expect(parseProbe(probe('2026.11.12'))).toEqual({
      dataDir: '/Users/admin/.local/share/mise',
      supports: { envJson: true, envPaths: true, installLocked: false },
      version: '2026.11.12',
      workflowBins: ['/wf/node/bin'],
    });
  });

  test('output of another shape is a ToolOutputError', () => {
    expect(() => parseProbe('{}')).toThrow(ToolOutputError);
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
