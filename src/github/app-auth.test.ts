import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPair, verify } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { processHandle } from '@loomcli/core';
import type { Host } from '@loomcli/core';

import { ConfigError, validateConfig } from '../config/schema';
import { messageOf } from '../errors';
import {
  checkAppKey,
  createInstallationTokens,
  expandHome,
  GitHubAppError,
  REFRESH_MARGIN_MS,
  requireGitHubApp,
  signAppJwt,
} from './app-auth';
import type { Fetch } from './pull-request';

const REPO = 'example/project';
const APP_ID = 4242;
const NOW = Date.parse('2026-01-01T00:00:00Z');

const handle = processHandle();
const realSpawn: Host['spawn'] = (command, args, options) =>
  handle.spawn(command, args, { cwd: handle.cwd(), env: handle.env, ...options });

/** A `spawn` whose `ls` prints `stdout` and exits `code`, whatever it was asked. */
function fakeLs(stdout: string, code = 0): Host['spawn'] {
  return () => ({
    abandon: () => undefined,
    exited: Promise.resolve({
      code,
      kind: 'exited',
      stderr: { bytes: new Uint8Array(), text: code === 0 ? '' : 'ls: boom' },
      stdout: { bytes: new Uint8Array(), text: stdout },
    }),
    kill: () => undefined,
  });
}

/** A `spawn` whose `ls` settles without an exit code, as an abandoned child does. */
const abandonedLs: Host['spawn'] = () => ({
  abandon: () => undefined,
  exited: Promise.resolve({
    kind: 'abandoned',
    stderr: { bytes: new Uint8Array(), text: '' },
    stdout: {
      bytes: new Uint8Array(),
      text: '-rw-------  1 me  staff  0 app.pem\n 0: group:x allow read\n',
    },
  }),
  kill: () => undefined,
});

const neverRun: Host['spawn'] = () => {
  throw new Error('ls must not run');
};

const makeKeyPair = promisify(generateKeyPair);
const { privateKey, publicKey } = await makeKeyPair('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' });

let dir: string;
let keyPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hugi-app-auth-'));
  keyPath = join(dir, 'app.pem');
  await writeFile(keyPath, PEM, { mode: 0o600 });
  await chmod(keyPath, 0o600);
});

afterAll(async () => {
  await rm(dir, { force: true, recursive: true });
});

type Call = { url: string; method: string; authorization: string; body: string | undefined };

/** A fake GitHub: answers the installation lookup and the token mint, and records each call. */
function fakeGitHub(
  options: { expiresInMs?: number; installation?: Response; mint?: Response } = {},
) {
  const calls: Call[] = [];
  let minted = 0;
  const fetch: Fetch = async (url, init) => {
    calls.push({
      authorization: init.headers.Authorization ?? '',
      body: init.body,
      method: init.method ?? 'GET',
      url,
    });
    if (url.endsWith('/installation')) {
      return options.installation ?? Response.json({ id: 99 });
    }
    minted += 1;
    return (
      options.mint ??
      Response.json(
        {
          expires_at: new Date(NOW + (options.expiresInMs ?? 3_600_000)).toISOString(),
          token: `ghs_token_${minted}`,
        },
        { status: 201 },
      )
    );
  };
  return { calls, fetch };
}

function tokens(
  fetch: Fetch,
  overrides: {
    now?: () => number;
    keyPath?: string;
    uid?: number;
    spawn?: Host['spawn'];
    platform?: string;
  } = {},
) {
  return createInstallationTokens({
    app: { appId: APP_ID, privateKeyPath: overrides.keyPath ?? keyPath },
    fetch,
    home: '/home/mock',
    now: overrides.now ?? (() => NOW),
    platform: overrides.platform ?? handle.platform,
    spawn: overrides.spawn ?? realSpawn,
    uid: overrides.uid ?? process.getuid?.(),
  });
}

async function failureOf(promise: Promise<unknown>): Promise<GitHubAppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitHubAppError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a GitHubAppError');
}

/** A JWT's three dot-separated parts. */
function partsOf(jwt: string): [string, string, string] {
  const [header, claims, signature, ...rest] = jwt.split('.');
  if (header === undefined || claims === undefined || signature === undefined || rest.length > 0) {
    throw new Error('not a JWT');
  }
  return [header, claims, signature];
}

describe('the App JWT', () => {
  test('carries the issuer and a nine-minute lifetime, signed RS256', () => {
    const jwt = signAppJwt(APP_ID, privateKey, NOW);
    const [header, claims, signature] = partsOf(jwt);
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const seconds = NOW / 1000;
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      exp: seconds + 540,
      iat: seconds - 60,
      iss: '4242',
    });
    const valid = verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${claims}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
    expect(valid).toBe(true);
  });

  test('does not verify against another key', async () => {
    const other = await makeKeyPair('rsa', { modulusLength: 2048 });
    const [header, claims, signature] = partsOf(signAppJwt(APP_ID, privateKey, NOW));
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${claims}`),
        other.publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(false);
  });
});

describe('minting an installation token', () => {
  test('looks up the installation with the JWT, then mints a token scoped to the repository', async () => {
    const { calls, fetch } = fakeGitHub();
    expect(await tokens(fetch)(REPO)()).toBe('ghs_token_1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET https://api.github.com/repos/${REPO}/installation`,
      'POST https://api.github.com/app/installations/99/access_tokens',
    ]);
    for (const call of calls) {
      expect(call.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u);
    }
    expect(JSON.parse(calls[1]!.body ?? '')).toEqual({ repositories: ['project'] });
  });

  test('caches the token for a repository until shortly before it expires', async () => {
    const { calls, fetch } = fakeGitHub({ expiresInMs: 3_600_000 });
    let now = NOW;
    const provider = tokens(fetch, { now: () => now })(REPO);
    expect(await provider()).toBe('ghs_token_1');
    now = NOW + 3_600_000 - REFRESH_MARGIN_MS - 1;
    expect(await provider()).toBe('ghs_token_1');
    expect(calls).toHaveLength(2);
    now = NOW + 3_600_000 - REFRESH_MARGIN_MS;
    expect(await provider()).toBe('ghs_token_2');
    expect(calls).toHaveLength(4);
  });

  test('gives one provider per repository, and concurrent callers share one mint', async () => {
    const { calls, fetch } = fakeGitHub();
    const forRepository = tokens(fetch);
    expect(forRepository(REPO)).toBe(forRepository(REPO));
    const [a, b] = await Promise.all([forRepository(REPO)(), forRepository(REPO)()]);
    expect([a, b]).toEqual(['ghs_token_1', 'ghs_token_1']);
    expect(calls).toHaveLength(2);
  });

  test('a failed mint is not cached', async () => {
    const calls: string[] = [];
    let healthy = false;
    const fetch: Fetch = async (url) => {
      calls.push(url);
      if (!healthy) {
        return new Response('{"message":"Bad credentials"}', { status: 401 });
      }
      return url.endsWith('/installation')
        ? Response.json({ id: 1 })
        : Response.json({ expires_at: new Date(NOW + 3_600_000).toISOString(), token: 't' });
    };
    const provider = tokens(fetch)(REPO);
    expect((await failureOf(provider())).message).toContain('Bad credentials');
    healthy = true;
    expect(await provider()).toBe('t');
  });

  test('a refused answer is one typed error naming the repository and endpoint', async () => {
    const { fetch } = fakeGitHub({
      installation: new Response('{"message":"Not Found"}', { status: 404 }),
    });
    const error = await failureOf(tokens(fetch)(REPO)());
    expect(error.repository).toBe(REPO);
    expect(error.endpoint).toBe(`GET /repos/${REPO}/installation`);
    expect(error.message).toContain('404');
    expect(error.status).toBe(404);
  });

  test('a 404 for the installation says to install the App on the repository', async () => {
    const { fetch } = fakeGitHub({
      installation: new Response('{"message":"Not Found"}', { status: 404 }),
    });
    const error = await failureOf(tokens(fetch)(REPO)());
    expect(error.message).toContain(
      `the Hugi GitHub App is not installed on ${REPO}; install it there`,
    );
  });

  test('a refusal that is not a 404 keeps its status and a network failure has none', async () => {
    const refused = await failureOf(
      tokens(fakeGitHub({ mint: new Response('{}', { status: 403 }) }).fetch)(REPO)(),
    );
    expect(refused.status).toBe(403);
    expect(refused.endpoint).toBe('POST /app/installations/99/access_tokens');
    const unreachable = await failureOf(
      tokens(async () => {
        throw new Error('reset');
      })(REPO)(),
    );
    expect(unreachable.status).toBeUndefined();
    expect(messageOf(unreachable.cause)).toBe('reset');
  });

  test('an unusable key keeps its error as the cause', async () => {
    const error = await failureOf(
      tokens(fakeGitHub().fetch, { keyPath: join(dir, 'none.pem') })(REPO)(),
    );
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.status).toBeUndefined();
  });

  test('an installation id that is not an integer is refused', async () => {
    const { calls, fetch } = fakeGitHub({ installation: Response.json({ id: 9.5 }) });
    const error = await failureOf(tokens(fetch)(REPO)());
    expect(error.message).toContain('has no installation id');
    expect(calls).toHaveLength(1);
  });

  test('an empty token is refused', async () => {
    const mint = Response.json({ expires_at: new Date(NOW + 3_600_000).toISOString(), token: '' });
    const error = await failureOf(tokens(fakeGitHub({ mint }).fetch)(REPO)());
    expect(error.message).toContain('no usable token');
  });

  test('invalidate drops the cached token, so the next call mints a fresh one', async () => {
    const { calls, fetch } = fakeGitHub();
    const forRepository = tokens(fetch);
    expect(await forRepository(REPO)()).toBe('ghs_token_1');
    forRepository.invalidate(REPO);
    expect(await forRepository(REPO)()).toBe('ghs_token_2');
    expect(calls).toHaveLength(4);
    forRepository.invalidate('never/seen');
  });

  test('a mint answer with no token names the mint endpoint', async () => {
    const { fetch } = fakeGitHub({ mint: Response.json({ token: 'x' }) });
    const error = await failureOf(tokens(fetch)(REPO)());
    expect(error.endpoint).toBe('POST /app/installations/99/access_tokens');
  });

  test('refuses a repository that is not owner/name', () => {
    expect(() => tokens(fakeGitHub().fetch)('../x')).toThrow(GitHubAppError);
  });
});

describe('the private key file', () => {
  test('refuses a key other users can read', async () => {
    const shared = join(dir, 'shared.pem');
    await writeFile(shared, PEM);
    await chmod(shared, 0o644);
    const { calls, fetch } = fakeGitHub();
    const error = await failureOf(tokens(fetch, { keyPath: shared })(REPO)());
    expect(error.message).toContain('can be read or written by other users');
    expect(error.message).toContain('chmod 600');
    expect(error.repository).toBe(REPO);
    expect(calls).toHaveLength(0);
  });

  test('refuses a key other users can write', async () => {
    const writable = join(dir, 'writable.pem');
    await writeFile(writable, PEM);
    await chmod(writable, 0o620);
    expect(
      (await failureOf(tokens(fakeGitHub().fetch, { keyPath: writable })(REPO)())).message,
    ).toContain('other users');
  });

  test('refuses a key owned by another user', async () => {
    const uid = (process.getuid?.() ?? 0) + 1;
    const error = await failureOf(tokens(fakeGitHub().fetch, { uid })(REPO)());
    expect(error.message).toContain('not owned by the current user');
  });

  test('refuses a key with an ACL entry, and says how to remove it', async () => {
    const listing = `-rw-------+ 1 u staff 1675 Nov 19 10:00 ${keyPath}\n 0: group:everyone allow read\n`;
    const { calls, fetch } = fakeGitHub();
    const error = await failureOf(
      tokens(fetch, { platform: 'darwin', spawn: fakeLs(listing) })(REPO)(),
    );
    expect(error.message).toContain('access control list');
    expect(error.message).toContain(`chmod -N ${keyPath}`);
    expect(calls).toHaveLength(0);
  });

  test('accepts a key whose listing has no ACL line', async () => {
    const listing = `-rw-------  1 u staff 1675 Nov 19 10:00 ${keyPath}\n`;
    const provider = tokens(fakeGitHub().fetch, { platform: 'darwin', spawn: fakeLs(listing) });
    expect(await provider(REPO)()).toBe('ghs_token_1');
  });

  test('refuses a key it could not look for an ACL on', async () => {
    const error = await failureOf(
      tokens(fakeGitHub().fetch, { platform: 'darwin', spawn: fakeLs('', 1) })(REPO)(),
    );
    expect(error.message).toContain('ACL');
  });

  test('refuses a key whose ACL probe ended without an exit code', async () => {
    const error = await failureOf(
      tokens(fakeGitHub().fetch, { platform: 'darwin', spawn: abandonedLs })(REPO)(),
    );
    expect(error.message).toContain('/bin/ls to look for an ACL ended without an exit code');
  });

  test('does not look for an ACL off macOS', async () => {
    const provider = tokens(fakeGitHub().fetch, { platform: 'linux', spawn: neverRun });
    expect(await provider(REPO)()).toBe('ghs_token_1');
  });

  test.skipIf(handle.platform !== 'darwin')('refuses a key with a real ACL entry', async () => {
    const acl = join(dir, 'acl.pem');
    await writeFile(acl, PEM, { mode: 0o600 });
    const set = await realSpawn('chmod', ['+a', 'everyone allow read', acl]).exited;
    expect(set.kind === 'exited' && set.code).toBe(0);
    const error = await failureOf(tokens(fakeGitHub().fetch, { keyPath: acl })(REPO)());
    expect(error.message).toContain('access control list');
  });

  test.skipIf(handle.platform !== 'darwin')(
    'refuses a key reached through a symbolic link when the target has an ACL entry',
    async () => {
      const target = join(dir, 'target.pem');
      await writeFile(target, PEM, { mode: 0o600 });
      const set = await realSpawn('chmod', ['+a', 'everyone allow read', target]).exited;
      expect(set.kind === 'exited' && set.code).toBe(0);
      const link = join(dir, 'link.pem');
      await symlink(target, link);
      const error = await failureOf(tokens(fakeGitHub().fetch, { keyPath: link })(REPO)());
      expect(error.message).toContain('access control list');
    },
  );

  test('refuses a directory at the key path', async () => {
    const folder = join(dir, 'folder.pem');
    await mkdir(folder, { mode: 0o700 });
    const error = await failureOf(tokens(fakeGitHub().fetch, { keyPath: folder })(REPO)());
    expect(error.message).toContain('not a regular file');
  });

  test('refuses a FIFO at the key path instead of hanging', async () => {
    const fifo = join(dir, 'pipe.pem');
    const made = await realSpawn('mkfifo', [fifo]).exited;
    expect(made.kind === 'exited' && made.code).toBe(0);
    const error = await failureOf(tokens(fakeGitHub().fetch, { keyPath: fifo })(REPO)());
    expect(error.message).toContain('not a regular file');
  });

  test('names a missing key and the key that points at it', async () => {
    const error = await failureOf(
      tokens(fakeGitHub().fetch, { keyPath: join(dir, 'none.pem') })(REPO)(),
    );
    expect(error.message).toContain('does not exist');
    expect(error.message).toContain('github_app.private_key_path');
  });

  test('refuses a file that is not a PEM key', async () => {
    const junk = join(dir, 'junk.pem');
    await writeFile(junk, 'not a key', { mode: 0o600 });
    expect(
      (await failureOf(tokens(fakeGitHub().fetch, { keyPath: junk })(REPO)())).message,
    ).toContain('cannot be read as a PEM private key');
  });

  test('refuses a key that is not RSA', async () => {
    const ec = join(dir, 'ec.pem');
    const pem = (await makeKeyPair('ec', { namedCurve: 'P-256' })).privateKey.export({
      format: 'pem',
      type: 'pkcs8',
    });
    await writeFile(ec, pem, { mode: 0o600 });
    expect(
      (await failureOf(tokens(fakeGitHub().fetch, { keyPath: ec })(REPO)())).message,
    ).toContain('not an RSA key');
  });
});

const appConfig = (path: string) =>
  validateConfig({
    allowlist: [],
    github_app: { app_id: APP_ID, private_key_path: path },
    repositories: [REPO],
  });

describe('the App configuration', () => {
  test('is required for posting, and its absence says how to add it', () => {
    const config = validateConfig({ allowlist: [], repositories: [REPO] });
    expect(() => requireGitHubApp(config)).toThrow(ConfigError);
    expect(() => requireGitHubApp(config)).toThrow('github_app: is not configured');
    expect(() => requireGitHubApp(config)).toThrow('private_key_path');
  });

  test('is returned when present', () => {
    const config = validateConfig({
      allowlist: [],
      github_app: { app_id: 5, private_key_path: '/k.pem' },
      repositories: [REPO],
    });
    expect(requireGitHubApp(config)).toEqual({ appId: 5, privateKeyPath: '/k.pem' });
  });

  test('the startup check accepts a usable key and refuses a missing one as a ConfigError', async () => {
    const host = { home: dir, platform: 'linux', spawn: realSpawn, uid: process.getuid?.() };
    expect(await checkAppKey(appConfig(keyPath), host)).toBeUndefined();
    const missing = await checkAppKey(appConfig(join(dir, 'missing.pem')), host).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(missing).toBeInstanceOf(ConfigError);
    expect(messageOf(missing)).toContain('github_app.private_key_path');
    expect(messageOf(missing)).toContain('does not exist');
  });

  test('a home-relative key path resolves under home', () => {
    expect(expandHome('~/keys/app.pem', '/home/mock/')).toBe('/home/mock/keys/app.pem');
    expect(expandHome('/abs/app.pem', '/home/mock')).toBe('/abs/app.pem');
  });
});
