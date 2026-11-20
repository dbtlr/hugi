import { expect, test } from 'bun:test';

import { mockProcess } from '@loomcli/testing';

import { createApp } from '../app';

const VALID = 'repositories: [dbtlr/hugi]\nallowlist: [dbtlr]\npoll_interval: 30\n';

/** Runs `hugi` with the given files by path; any other path is missing. */
async function hugi(
  argv: string[],
  files: Record<string, string>,
  env: Record<string, string> = {},
) {
  const tried: string[] = [];
  const mock = mockProcess({ argv, env: { HOME: '/home/mock', ...env }, stdin: '' });
  const exitCode = await createApp(
    {},
    {
      readText: async (path) => {
        tried.push(path);
        const text = files[path];
        if (text === undefined) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return text;
      },
    },
  ).run({ process: mock });
  return { exitCode, stderr: mock.stderr.text, stdout: mock.stdout.text, tried };
}

test('a valid file exits 0 and prints the effective configuration', async () => {
  const { exitCode, stdout } = await hugi(['config', 'check', '--config', '/c.yaml'], {
    '/c.yaml': VALID,
  });
  expect(exitCode).toBe(0);
  expect(stdout).toContain('configuration: /c.yaml (valid)');
  expect(stdout).toContain('  - dbtlr/hugi');
  expect(stdout).toContain('poll_interval: 30');
  expect(stdout).toContain('vm: 4 cpus, 4 GB memory');
  expect(stdout).toContain('runs: keep 30 days, up to 5 GB');
  expect(stdout).toContain('github_app: not configured');
});

test('a configured github_app prints its id and key path', async () => {
  const { stdout } = await hugi(['config', 'check', '--config', '/c.yaml'], {
    '/c.yaml': `${VALID}github_app:\n  app_id: 7\n  private_key_path: ~/app.pem\n`,
  });
  expect(stdout).toContain('github_app: 7, key ~/app.pem');
});

test('an empty allowlist prints as none', async () => {
  const { stdout } = await hugi(['config', 'check', '--config', '/c.yaml'], {
    '/c.yaml': 'repositories: [a/b]\nallowlist: []\n',
  });
  expect(stdout).toContain('allowlist: (none)');
});

test('--format json prints the path and the configuration', async () => {
  const { exitCode, stdout } = await hugi(
    ['config', 'check', '--config', '/c.yaml', '--format', 'json'],
    {
      '/c.yaml': VALID,
    },
  );
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    config: {
      allowlist: ['dbtlr'],
      pollIntervalSeconds: 30,
      repositories: ['dbtlr/hugi'],
      runs: { maxAgeDays: 30, maxSizeGb: 5 },
      vm: { cpus: 4, memoryGb: 4 },
    },
    path: '/c.yaml',
  });
});

test('without --config the file is HUGI_CONFIG, else the XDG default under home', async () => {
  const fromEnv = await hugi(
    ['config', 'check'],
    { '/env.yaml': VALID },
    { HUGI_CONFIG: '/env.yaml' },
  );
  expect(fromEnv.exitCode).toBe(0);
  const fromDefault = await hugi(['config', 'check'], {});
  expect(fromDefault.tried).toEqual(['/home/mock/.config/hugi/config.yaml']);
});

test('a missing file exits 1 and names the path and how to point Hugi at a configuration', async () => {
  const { exitCode, stderr, stdout } = await hugi(
    ['config', 'check', '--config', '/nope.yaml'],
    {},
  );
  expect(exitCode).toBe(1);
  expect(stdout).toBe('');
  expect(stderr).toContain('/nope.yaml');
  expect(stderr).toContain('HUGI_CONFIG');
});

test('a refused file exits 1 and names the key path', async () => {
  const { exitCode, stderr } = await hugi(['config', 'check', '--config', '/c.yaml'], {
    '/c.yaml': 'repositories: [a/b, nope]\nallowlist: []\n',
  });
  expect(exitCode).toBe(1);
  expect(stderr).toContain('repositories[1]');
});
