/**
 * The one way Hugi starts `git` on the host. Every invocation is hardened so that neither the
 * repository being read nor the host's own git setup can make git run a program or use a
 * credential (ADR-0002):
 *
 * - Every inherited `GIT_*` variable is dropped, so none can point git at another repository
 *   (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_OBJECT_DIRECTORY`, ...) or name a program (`GIT_SSH_COMMAND`,
 *   `GIT_PROXY_COMMAND`, ...).
 * - `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null` ignore the system and user config, so
 *   an `insteadOf` rewrite, a helper, or an `uploadpack` setting there never applies.
 * - `protocol.allow=never` with only the remote transport (`https`) allowed, and every known
 *   transport named explicitly, so a repository's own `protocol.<name>.allow` cannot re-enable
 *   `file`, `ssh`, or `ext`. A `remote.*.uploadpack` or `core.sshCommand` only runs over those
 *   refused transports; `core.sshCommand` is also overridden.
 * - `credential.helper=`, `http.extraHeader=`, `GIT_TERMINAL_PROMPT=0`, and `GIT_ASKPASS=true`: no
 *   credential, header, or prompt. `HOME=/dev/null`, so libcurl finds no `.netrc` to log in with.
 * - `GIT_NO_REPLACE_OBJECTS=1`, so a replacement ref cannot make a read see another commit than
 *   the one the snapshot carries.
 * - `core.hooksPath=/dev/null`, `core.fsmonitor=false`, and `core.alternateRefsCommand=true`: no
 *   hook, monitor, or alternate-refs command runs.
 * - `GIT_NO_LAZY_FETCH=1` for a local repository, so a partial clone's promisor remote is never
 *   contacted: a missing object is a read failure, not a fetch.
 */
import type { Child, ChildExit, Host } from '@loomcli/core';

import { systemClock } from '../vm/clock';
import { resolvesWithin } from '../vm/deadline';
import type { Clock } from '../vm/tart';

/** The service allows up to ten minutes for each host git command. */
export const SERVICE_GIT_DEADLINE_MS = 600_000;

const GIT_TERM_GRACE_MS = 1000;
const GIT_KILL_WAIT_MS = 1000;

/** The transport a remote source fetches over: https in production; tests serve fixtures over file. */
export type GitTransport = 'file' | 'https';

export type GitOptions = {
  /** The run's `host.spawn`, the only way this module starts a program. */
  readonly spawn: Host['spawn'];
  /** An optional deadline for each git call, before termination begins. */
  readonly deadlineMs?: number;
  /** The run's `host.env`, from which git's environment is built. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** The one transport git may use. */
  readonly transport: GitTransport;
  /** False for a local repository: its promisor remote, if any, is never fetched from. */
  readonly lazyFetch: boolean;
};

export type GitOutcome = { readonly ok: boolean; readonly stdout: string; readonly stderr: string };

/** Starts `git`, scoped to `gitDir` when given; a failure to start counts as a failed command. */
export type Git = (gitDir: string | undefined, args: readonly string[]) => Promise<GitOutcome>;

/** Every transport git ships with; each one but the allowed transport is refused by name. */
const TRANSPORTS = ['ext', 'fd', 'file', 'git', 'http', 'https', 'ssh'] as const;

/** The `-c` settings every invocation carries; command-line config wins over the repository's. */
export function hardenedConfig(transport: GitTransport): string[] {
  const settings = [
    'credential.helper=',
    'http.extraHeader=',
    'core.sshCommand=false',
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'core.alternateRefsCommand=true',
    'protocol.allow=never',
    ...TRANSPORTS.map(
      (name) => `protocol.${name}.allow=${name === transport ? 'always' : 'never'}`,
    ),
  ];
  return settings.flatMap((setting) => ['-c', setting]);
}

/**
 * The host's environment without any `GIT_*` variable or home, plus the hardening variables. git
 * runs in the C locale, because Hugi reads some of its error messages to tell one failure from another.
 */
export function hardenedEnv(
  inherited: Readonly<Record<string, string | undefined>>,
  lazyFetch: boolean,
): Record<string, string | undefined> {
  const env = Object.fromEntries(
    Object.entries(inherited).filter(([name]) => !name.startsWith('GIT_')),
  );
  return {
    ...env,
    GIT_ASKPASS: 'true',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    HOME: '/dev/null',
    LANGUAGE: 'C',
    LC_ALL: 'C',
    ...(lazyFetch ? {} : { GIT_NO_LAZY_FETCH: '1' }),
  };
}

function outcomeOf(exit: ChildExit): GitOutcome {
  if (exit.kind === 'unstarted') {
    return { ok: false, stderr: exit.error.message, stdout: '' };
  }
  return {
    ok: exit.kind === 'exited' && exit.code === 0,
    stderr: exit.stderr.text,
    stdout: exit.stdout.text,
  };
}

/** Give git a chance to exit gracefully and bound the wait even if its pipes stay open. */
async function terminateGit(child: Child, clock: Clock): Promise<ChildExit | undefined> {
  child.kill('SIGTERM');
  const terminated = await resolvesWithin(clock, child.exited, GIT_TERM_GRACE_MS);
  if (terminated !== undefined) {
    return terminated;
  }
  child.kill('SIGKILL');
  const killed = await resolvesWithin(clock, child.exited, GIT_KILL_WAIT_MS);
  if (killed === undefined) {
    // A helper git started can hold its pipes open past the kill; let the host stop waiting on it.
    child.abandon();
  }
  return killed;
}

async function boundedOutcome(child: Child, clock: Clock, deadlineMs: number): Promise<GitOutcome> {
  const exit = await resolvesWithin(clock, child.exited, deadlineMs);
  if (exit !== undefined) {
    return outcomeOf(exit);
  }
  const stopped = await terminateGit(child, clock);
  return {
    ok: false,
    stderr: `git timed out after ${deadlineMs / 1000} seconds.`,
    stdout: stopped?.kind === 'exited' ? stopped.stdout.text : '',
  };
}

export function createGit(options: GitOptions, clock: Clock = systemClock): Git {
  const env = hardenedEnv(options.env, options.lazyFetch);
  const config = hardenedConfig(options.transport);
  const { deadlineMs } = options;
  return async (gitDir, args) => {
    const scoped = gitDir === undefined ? [] : ['--git-dir', gitDir];
    const child = options.spawn('git', [...config, ...scoped, ...args], {
      cwd: options.cwd,
      env,
    });
    return deadlineMs === undefined
      ? outcomeOf(await child.exited)
      : boundedOutcome(child, clock, deadlineMs);
  };
}
