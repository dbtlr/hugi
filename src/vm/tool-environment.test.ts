import { describe, expect, test } from 'bun:test';

import {
  canonicalToolName,
  configFilesInWorkspace,
  mergeToolEnvironments,
  parseConfigListing,
  parseToolEnvironment,
  requestedVersions,
  versionConflicts,
  workflowPins,
} from './tool-environment';

const WORKSPACE = '/mock/workspace';

const workspaceLine = (real: string) => JSON.stringify({ kind: 'workspace', real });
const fileLine = (real: string, path: string) => JSON.stringify({ kind: 'file', path, real });
const listing = (lines: string[]) => parseConfigListing(`${lines.join('\n')}\n`);
const entry = (version: string, type: string, path: string) => ({
  requested_version: version,
  source: { path, type },
});

describe('canonicalToolName', () => {
  test.each([
    ['nodejs', 'node'],
    ['core:node', 'node'],
    ['core:bun', 'bun'],
    ['golang', 'go'],
    ['pnpm', 'pnpm'],
    ['npm:pnpm', 'npm:pnpm'],
  ])('%s is %s', (name, expected) => {
    expect(canonicalToolName(name)).toBe(expected);
  });
});

describe('workflowPins', () => {
  test('reads name and version, and skips a spec with no version', () => {
    expect(workflowPins(['nodejs@22.23.2', 'bun@1.4.4', 'rust'])).toEqual([
      { name: 'node', version: '22.23.2' },
      { name: 'bun', version: '1.4.4' },
    ]);
  });
});

describe('parseToolEnvironment', () => {
  test('keeps string variables', () => {
    expect(parseToolEnvironment('{"PATH":"/a:/b","RUSTUP_TOOLCHAIN":"1.97.1"}')).toEqual({
      PATH: '/a:/b',
      RUSTUP_TOOLCHAIN: '1.97.1',
    });
  });

  test.each(['', 'nope', '[]', '{"PATH":1}', '{"A":"b"}'])('refuses %p', (text) => {
    expect(() => parseToolEnvironment(text)).toThrow(/tool environment/);
  });

  test.each(['BAD-KEY', '1ST', 'A B', 'A=B', "A';rm -rf x;'", 'ünï'])(
    'keeps the key %p, which is not a shell name',
    (key) => {
      const text = JSON.stringify(
        Object.fromEntries([
          [key, 'x'],
          ['PATH', '/usr/bin'],
        ]),
      );
      expect(Object.entries(parseToolEnvironment(text))).toEqual([
        [key, 'x'],
        ['PATH', '/usr/bin'],
      ]);
    },
  );

  test('refuses an empty PATH', () => {
    expect(() => parseToolEnvironment('{"PATH":""}')).toThrow(/no PATH/);
  });

  test('accepts the names a shell accepts', () => {
    expect(parseToolEnvironment('{"_A1":"x","a_B":"y","PATH":"/usr/bin"}')).toEqual({
      PATH: '/usr/bin',
      _A1: 'x',
      a_B: 'y',
    });
  });
});

describe('the config files inside the workspace', () => {
  test('keeps a file whose resolved path lies inside the workspace', () => {
    const found = configFilesInWorkspace(
      listing([
        workspaceLine(WORKSPACE),
        fileLine(`${WORKSPACE}/mise.toml`, `${WORKSPACE}/mise.toml`),
        fileLine(`${WORKSPACE}/sub/.tool-versions`, `${WORKSPACE}/sub/.tool-versions`),
        '',
      ]),
    );
    expect(found).toEqual([`${WORKSPACE}/mise.toml`, `${WORKSPACE}/sub/.tool-versions`]);
  });

  test('drops files outside the workspace, a sibling with the same prefix, and a symlink pointing out', () => {
    const found = configFilesInWorkspace(
      listing([
        workspaceLine(WORKSPACE),
        fileLine('/mock/home/.config/mise/config.toml', '/mock/home/.config/mise/config.toml'),
        fileLine(`${WORKSPACE}-other/mise.toml`, `${WORKSPACE}-other/mise.toml`),
        fileLine('/mock/elsewhere/mise.toml', `${WORKSPACE}/mise.toml`),
      ]),
    );
    expect(found).toEqual([]);
  });

  test('a listing with no workspace line is refused', () => {
    expect(() => parseConfigListing(`${fileLine('/a', '/a')}\n`)).toThrow(/workspace/);
  });

  test('a line that is not a listing record is refused', () => {
    expect(() => parseConfigListing('workspace\t/a\n')).toThrow(/not JSON/);
    expect(() => parseConfigListing(`${workspaceLine('/a')}\n{"kind":"other"}\n`)).toThrow(
      /unknown shape/,
    );
  });

  test.each([
    ['a tab', 'a\tb'],
    ['a newline', 'a\nb'],
    ['a trailing newline', 'a\n'],
    ['quotes and a backslash', String.raw`a"b\c'd`],
  ])('keeps a file name with %s in one piece, and counts it inside', (_what, name) => {
    const path = `${WORKSPACE}/.config/mise/conf.d/${name}.toml`;
    const parsed = listing([workspaceLine(WORKSPACE), fileLine(path, path)]);
    expect(parsed.files).toEqual([{ path, real: path }]);
    expect(configFilesInWorkspace(parsed)).toEqual([path]);
  });
});

describe('requestedVersions', () => {
  const inside = [`${WORKSPACE}/mise.toml`];

  test('groups entries under their canonical name, keeping every requested version', () => {
    const json = JSON.stringify({
      node: [entry('22', 'mise.toml', inside[0]!)],
      pnpm: [entry('1', 'mise.toml', inside[0]!), entry('2', 'mise.toml', inside[0]!)],
    });
    expect(requestedVersions(json, inside)).toEqual(
      new Map([
        ['node', { file: inside[0]!, versions: ['22'] }],
        ['pnpm', { file: inside[0]!, versions: ['1', '2'] }],
      ]),
    );
  });

  test('skips an idiomatic version file and a source outside the workspace', () => {
    const json = JSON.stringify({
      bun: [entry('1.0.0', 'mise.toml', '/mock/home/.config/mise/config.toml')],
      node: [entry('22', 'idiomatic-version-file', `${WORKSPACE}/.nvmrc`)],
      rust: [entry('1.97.1', 'idiomatic-version-file', inside[0]!)],
    });
    expect(requestedVersions(json, inside).size).toBe(0);
  });

  test('a name with a tab still hides nothing from the check', () => {
    const odd = `${WORKSPACE}/.config/mise/conf.d/a\tb.toml`;
    const requested = requestedVersions(JSON.stringify({ node: [entry('22', 'mise.toml', odd)] }), [
      odd,
    ]);
    expect(requested.get('node')).toEqual({ file: odd, versions: ['22'] });
  });

  test('a requested version that is not text fails, naming the tool and the file', () => {
    for (const requested_version of [22, null, ['22']]) {
      const json = JSON.stringify({
        node: [{ requested_version, source: { path: inside[0], type: 'mise.toml' } }],
      });
      expect(() => requestedVersions(json, inside)).toThrow(/node.*mise\.toml.*not text/);
    }
  });

  test("a version that is not text is skipped when the entry is not the workspace config's", () => {
    const json = JSON.stringify({
      node: [
        { requested_version: 22, source: { path: '/mock/home/config.toml', type: 'mise.toml' } },
        { requested_version: 22, source: { path: inside[0], type: 'idiomatic-version-file' } },
      ],
    });
    expect(requestedVersions(json, inside).size).toBe(0);
  });

  test('refuses output that is not the listing', () => {
    expect(() => requestedVersions('[]', inside)).toThrow(/mise ls/);
  });
});

describe('versionConflicts', () => {
  const file = `${WORKSPACE}/mise.toml`;

  test('names the tool, both versions and the file when they differ as written', () => {
    const conflicts = versionConflicts(
      [{ name: 'node', version: '22.23.2' }],
      new Map([['node', { file, versions: ['22'] }]]),
    );
    expect(conflicts).toEqual([
      `node: the workflow pins 22.23.2, but ${file} requests 22; make the two agree`,
    ]);
  });

  test('accepts the same version as written', () => {
    expect(
      versionConflicts(
        [{ name: 'node', version: '22.23.2' }],
        new Map([['node', { file, versions: ['22.23.2'] }]]),
      ),
    ).toEqual([]);
  });

  test('fails when the config requests several versions of a workflow tool', () => {
    const conflicts = versionConflicts(
      [{ name: 'pnpm', version: '1' }],
      new Map([['pnpm', { file, versions: ['1', '2'] }]]),
    );
    expect(conflicts[0]).toContain('pnpm');
    expect(conflicts[0]).toContain('1, 2');
    expect(conflicts[0]).toContain(file);
  });

  test('ignores tools only one side names', () => {
    expect(
      versionConflicts(
        [{ name: 'node', version: '22' }],
        new Map([['actionlint', { file, versions: ['1.7.0'] }]]),
      ),
    ).toEqual([]);
  });
});

describe('mergeToolEnvironments', () => {
  const first = { PATH: '/first/node:/base', RUSTUP_TOOLCHAIN: 'image' };
  const config = {
    CARGO_HOME: '/cfg/cargo',
    PATH: '/cfg/tool:/first/node:/base',
    RUSTUP_TOOLCHAIN: 'cfg',
  };
  const noWorkflowRust = { PATH: '/first/node:/base' };

  test('orders the workflow bins, the config PATH, then the first PATH, without duplicates', () => {
    const merged = mergeToolEnvironments({
      config,
      first: { ...first, PATH: '/first/node:/first/extra:/base' },
      workflowBins: ['/first/node'],
      workflowOnly: noWorkflowRust,
    });
    expect(merged.PATH).toBe('/first/node:/cfg/tool:/base:/first/extra');
  });

  test("the config's variables win over an image default's, so a Rust the config pins sets RUSTUP_TOOLCHAIN", () => {
    const merged = mergeToolEnvironments({
      config,
      first,
      workflowBins: [],
      workflowOnly: noWorkflowRust,
    });
    expect(merged.RUSTUP_TOOLCHAIN).toBe('cfg');
    expect(merged.CARGO_HOME).toBe('/cfg/cargo');
  });

  test("a variable a workflow tool sets keeps the first environment's value over the config's", () => {
    const merged = mergeToolEnvironments({
      config,
      first: { ...first, RUSTUP_TOOLCHAIN: 'workflow' },
      workflowBins: [],
      workflowOnly: { PATH: '/wf/rust', RUSTUP_TOOLCHAIN: 'workflow-alone' },
    });
    expect(merged.RUSTUP_TOOLCHAIN).toBe('workflow');
  });

  test('a variable a workflow tool sets stays when the config drops it, as disable_tools does', () => {
    const merged = mergeToolEnvironments({
      config: { PATH: '/cfg/tool:/base' },
      first: { ...first, RUSTUP_TOOLCHAIN: 'workflow' },
      workflowBins: [],
      workflowOnly: { PATH: '/wf/rust', RUSTUP_TOOLCHAIN: 'workflow' },
    });
    expect(merged.RUSTUP_TOOLCHAIN).toBe('workflow');
  });

  test("a variable the workflow tools alone set but the first does not keeps the config's value", () => {
    const merged = mergeToolEnvironments({
      config: { GOROOT: '/cfg/go', PATH: '/cfg/tool' },
      first,
      workflowBins: [],
      workflowOnly: { GOROOT: '/wf/go', PATH: '/wf/go/bin' },
    });
    expect(merged.GOROOT).toBe('/cfg/go');
  });

  test('a variable only the first environment sets stays', () => {
    const merged = mergeToolEnvironments({
      config: { PATH: '/cfg/tool' },
      first: { ...first, GOROOT: '/image/go' },
      workflowBins: [],
      workflowOnly: noWorkflowRust,
    });
    expect(merged.GOROOT).toBe('/image/go');
  });
});
