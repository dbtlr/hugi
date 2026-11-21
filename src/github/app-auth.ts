/**
 * Authenticates as the Hugi GitHub App (ADR-0002). The App's private key lives in a file on the
 * host and signs a short-lived JWT; the JWT buys a per-repository installation token, which is
 * cached until shortly before it expires and handed out as a `TokenProvider`. Everything here
 * runs on the host: neither the key, the JWT nor a token is ever given to a VM.
 */
import { createPrivateKey, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import type { Host } from '@loomcli/core';

import { ConfigError, isRepositoryName } from '../config/schema';
import type { GitHubAppConfig, HugiConfig } from '../config/schema';
import { errnoCode } from '../errno';
import { messageOf } from '../errors';
import { hasAccessControlList, judgePrivacy } from '../source/private-path';
import { isMapping } from '../yaml/strict';
import type { TokenProvider } from './client';
import type { Fetch } from './pull-request';
import { requestJson } from './request';
import type { FailureDetail } from './request';

/**
 * Hugi could not authenticate as the App for a repository: the key is unusable or GitHub refused
 * to mint a token. It names the repository and the call that needed the credential. A caller
 * decides on a retry from `status`: absent means GitHub gave no answer (the key, the network or a
 * timeout, so retrying later may help); 5xx and 429 may pass; 401, 403 and 404 will not until the
 * App's installation or permissions change. `cause` is the error underneath.
 */
export class GitHubAppError extends Error {
  override readonly name = 'GitHubAppError';
  /** `owner/name`. */
  readonly repository: string;
  /** The method and path that needed the credential, such as `GET /repos/owner/name/installation`. */
  readonly endpoint: string;
  /** GitHub's HTTP status, when GitHub answered. */
  readonly status: number | undefined;

  constructor(repository: string, endpoint: string, message: string, detail: FailureDetail = {}) {
    super(message, 'cause' in detail ? { cause: detail.cause } : undefined);
    this.repository = repository;
    this.endpoint = endpoint;
    this.status = detail.status;
  }
}

/**
 * The App's configuration, or a `ConfigError` saying how to add it. `hugi run` works without an
 * App; only the code that posts statuses needs one.
 */
export function requireGitHubApp(config: HugiConfig): GitHubAppConfig {
  if (config.githubApp === undefined) {
    throw new ConfigError(
      'github_app: is not configured, and posting commit statuses needs the Hugi GitHub App. ' +
        'Add github_app with app_id and private_key_path to the configuration file.',
    );
  }
  return config.githubApp;
}

/**
 * Throw a `ConfigError` saying what to fix unless the configuration names a GitHub App whose
 * private key is a usable key file, as `createInstallationTokens` will read it. `hugi serve` checks
 * this when it starts, so a bad key refuses the start instead of failing every post.
 */
export async function checkAppKey(
  config: HugiConfig,
  host: Pick<InstallationTokenOptions, 'home' | 'platform' | 'spawn' | 'uid'>,
): Promise<void> {
  const app = requireGitHubApp(config);
  try {
    await readPrivateKey(
      expandHome(app.privateKeyPath, host.home),
      host.uid,
      host.spawn,
      host.platform,
    );
  } catch (error) {
    throw new ConfigError(`github_app.private_key_path: ${messageOf(error)}`);
  }
}

/** `~/x` becomes `x` under `home`; any other path is returned as written. */
export function expandHome(path: string, home: string): string {
  return path.startsWith('~/') ? `${home.replace(/\/+$/u, '')}/${path.slice(2)}` : path;
}

/** Mode bits that let another user read or write the key. */
const KEY_SHARED_ACCESS = 0o077;

/** GitHub rejects an App JWT that lives over ten minutes. */
const JWT_LIFETIME_SECONDS = 9 * 60;
/** Backdated so a host clock slightly ahead of GitHub's does not make the JWT "from the future". */
const JWT_CLOCK_SKEW_SECONDS = 60;

/** An installation token is replaced this long before GitHub expires it. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** The App's JWT: RS256, issued by `appId`, valid for nine minutes from `nowMs`. */
export function signAppJwt(appId: number, key: KeyObject, nowMs: number): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      exp: nowSeconds + JWT_LIFETIME_SECONDS,
      iat: nowSeconds - JWT_CLOCK_SKEW_SECONDS,
      iss: String(appId),
    }),
  );
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), key);
  return `${header}.${claims}.${base64url(signature)}`;
}

/**
 * Read the key at `path`, refusing anything but a regular file that only the current user can
 * reach. The file is opened once and judged by that handle's `fstat`, so the file checked is the
 * file read. It is opened non-blocking, because opening a FIFO would otherwise wait for a writer.
 */
async function readPrivateKey(
  path: string,
  uid: number | undefined,
  spawn: Host['spawn'],
  platform: string,
): Promise<KeyObject> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      throw new Error(
        `The GitHub App private key ${path} does not exist; set github_app.private_key_path to the key file.`,
        { cause: error },
      );
    }
    throw new Error(`The GitHub App private key ${path} cannot be opened: ${messageOf(error)}`, {
      cause: error,
    });
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(
        `The GitHub App private key ${path} is not a regular file; set github_app.private_key_path to the key file.`,
      );
    }
    const privacy = judgePrivacy(info, uid, KEY_SHARED_ACCESS);
    if (privacy === 'foreign-owner') {
      throw new Error(
        `The GitHub App private key ${path} is not owned by the current user; use a key file you own.`,
      );
    }
    if (privacy === 'shared-access') {
      throw new Error(
        `The GitHub App private key ${path} can be read or written by other users; run chmod 600 on it.`,
      );
    }
    if (await hasAccessControlList(path, spawn, platform)) {
      throw new Error(
        `The GitHub App private key ${path} has an access control list, which can let other users read it; run chmod -N ${path} to remove it.`,
      );
    }
    return keyFrom(path, await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

function keyFrom(path: string, pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw new Error(
      `The GitHub App private key ${path} cannot be read as a PEM private key: ${messageOf(error)}`,
      { cause: error },
    );
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(`The GitHub App private key ${path} is not an RSA key.`);
  }
  return key;
}

export type InstallationTokenOptions = {
  readonly app: GitHubAppConfig;
  readonly fetch: Fetch;
  /** The host's home directory, which a `~/` key path is relative to. */
  readonly home: string;
  /** The run's `host.uid`: the only user the key file may belong to. */
  readonly uid: number | undefined;
  /** The run's `host.spawn`, which lists the key's ACL on macOS. */
  readonly spawn: Host['spawn'];
  /** The run's `host.platform`. */
  readonly platform: string;
  /** Milliseconds since the epoch; a test replaces it. */
  readonly now?: () => number;
  /** How long each GitHub request may take. */
  readonly timeoutMs?: number;
};

type Provider = { readonly token: TokenProvider; readonly invalidate: () => void };

type Installation = { readonly token: string; readonly refreshAtMs: number };

function installationIdOf(body: unknown): number | undefined {
  return isMapping(body) && typeof body.id === 'number' && Number.isInteger(body.id)
    ? body.id
    : undefined;
}

/** The token and its expiry from the access-token answer, or `undefined` when it is malformed. */
function tokenOf(body: unknown): { token: string; expiresAtMs: number } | undefined {
  if (!isMapping(body) || typeof body.token !== 'string' || body.token === '') {
    return undefined;
  }
  const expiresAtMs =
    typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN;
  return Number.isNaN(expiresAtMs) ? undefined : { expiresAtMs, token: body.token };
}

/** The `TokenProvider` of each repository, and the way to drop a repository's cached token. */
export type InstallationTokens = ((repository: string) => TokenProvider) & {
  /** Forget the repository's cached token, such as one GitHub answered 401 for. */
  readonly invalidate: (repository: string) => void;
};

/**
 * A `TokenProvider` for each repository, minting an installation token on first use and again
 * once the cached one is within `REFRESH_MARGIN_MS` of expiring. Concurrent callers share one
 * mint. The token is scoped to the one repository.
 */
export function createInstallationTokens(options: InstallationTokenOptions): InstallationTokens {
  const now = options.now ?? Date.now;
  const { platform } = options;
  const keyPath = expandHome(options.app.privateKeyPath, options.home);
  const providers = new Map<string, Provider>();

  const mint = async (repository: string): Promise<Installation> => {
    const installationEndpoint = `GET /repos/${repository}/installation`;
    const failAt = (endpoint: string) => (message: string, detail?: FailureDetail) =>
      new GitHubAppError(
        repository,
        endpoint,
        endpoint === installationEndpoint && detail?.status === 404
          ? `${message} Cause: the Hugi GitHub App is not installed on ${repository}; install it there.`
          : message,
        detail,
      );
    let jwt: string;
    try {
      const key = await readPrivateKey(keyPath, options.uid, options.spawn, platform);
      jwt = signAppJwt(options.app.appId, key, now());
    } catch (error) {
      throw new GitHubAppError(repository, installationEndpoint, messageOf(error), {
        cause: error,
      });
    }
    const common = {
      bearer: jwt,
      fetch: options.fetch,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };
    const installationPath = `/repos/${repository}/installation`;
    const found = await requestJson({
      ...common,
      fail: failAt(installationEndpoint),
      method: 'GET',
      path: installationPath,
    });
    const id = installationIdOf(found);
    if (id === undefined) {
      throw new GitHubAppError(
        repository,
        installationEndpoint,
        `GitHub's answer for ${installationEndpoint} has no installation id.`,
      );
    }
    const tokenPath = `/app/installations/${id}/access_tokens`;
    const tokenEndpoint = `POST ${tokenPath}`;
    const minted = tokenOf(
      await requestJson({
        ...common,
        body: { repositories: [repository.split('/')[1]] },
        fail: failAt(tokenEndpoint),
        method: 'POST',
        path: tokenPath,
      }),
    );
    if (minted === undefined) {
      throw new GitHubAppError(
        repository,
        tokenEndpoint,
        `GitHub's answer for ${tokenEndpoint} has no usable token and expires_at.`,
      );
    }
    return { refreshAtMs: minted.expiresAtMs - REFRESH_MARGIN_MS, token: minted.token };
  };

  const providerFor = (repository: string): Provider => {
    let cached: Installation | undefined;
    let inflight: Promise<Installation> | undefined;
    const refresh = async (): Promise<Installation> => {
      try {
        cached = await mint(repository);
        return cached;
      } finally {
        inflight = undefined;
      }
    };
    const token: TokenProvider = async () => {
      if (cached !== undefined && now() < cached.refreshAtMs) {
        return cached.token;
      }
      inflight ??= refresh();
      return (await inflight).token;
    };
    return { invalidate: () => void (cached = undefined), token };
  };

  const forRepository = (repository: string): TokenProvider => {
    if (!isRepositoryName(repository)) {
      throw new GitHubAppError(
        repository,
        'GET /repos/{owner}/{repo}/installation',
        `"${repository}" is not an owner/name repository.`,
      );
    }
    let provider = providers.get(repository);
    if (provider === undefined) {
      provider = providerFor(repository);
      providers.set(repository, provider);
    }
    return provider.token;
  };

  return Object.assign(forRepository, {
    invalidate: (repository: string) => providers.get(repository)?.invalidate(),
  });
}
