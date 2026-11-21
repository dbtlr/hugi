/** Who may touch a path on the host, shared by the clone cache and the App key. */
import { realpath, stat } from 'node:fs/promises';

import type { Host } from '@loomcli/core';

/** What `inspectPrivacy` found at a path. */
export type PathPrivacy = 'missing' | 'private' | 'foreign-owner' | 'shared-access';

/** The owner and mode of a path, as `stat` or `fstat` report them. */
export type PathFacts = { readonly uid: number; readonly mode: number };

/**
 * Whether a path with `info` belongs to the current user and none of `sharedBits` (mode bits other
 * users must not hold) are set. A runtime with no user ID skips the owner check. The owner is
 * judged first.
 */
export function judgePrivacy(
  info: PathFacts,
  uid: number | undefined,
  sharedBits: number,
): Exclude<PathPrivacy, 'missing'> {
  if (uid !== undefined && info.uid !== uid) {
    return 'foreign-owner';
  }
  return (info.mode & sharedBits) === 0 ? 'private' : 'shared-access';
}

/** `judgePrivacy` for the path itself, `missing` when it cannot be examined. */
export async function inspectPrivacy(
  path: string,
  uid: number | undefined,
  sharedBits: number,
): Promise<PathPrivacy> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return 'missing';
  }
  return judgePrivacy(info, uid, sharedBits);
}

/** How long the macOS `ls` that lists a path's ACL may take. */
const ACL_PROBE_TIMEOUT_MS = 5000;

/**
 * Whether `path` has an access control list. A mode of 0600 does not stop macOS from honouring an
 * ACL entry such as `everyone allow read`, and `ls -le` prints each entry on a line after the
 * file's own. Only macOS (`platform` is `darwin`) is checked: elsewhere this answers `false`. A probe that cannot run
 * throws, so the caller refuses rather than trusting a file it could not examine.
 */
export async function hasAccessControlList(
  path: string,
  spawn: Host['spawn'],
  platform: string,
): Promise<boolean> {
  if (platform !== 'darwin') {
    return false;
  }
  // macOS `ls` lists a symbolic link's own ACL, and `-L` drops the ACL from its listing, so the
  // probe names the file the link resolves to: the one the key is read from.
  const exit = await spawn('/bin/ls', ['-led', '--', await realpath(path)], {
    signal: AbortSignal.timeout(ACL_PROBE_TIMEOUT_MS),
  }).exited;
  if (exit.kind === 'unstarted') {
    throw new Error(`cannot start /bin/ls to look for an ACL: ${exit.error.message}`);
  }
  if (exit.kind === 'abandoned') {
    throw new Error('/bin/ls to look for an ACL ended without an exit code');
  }
  if (exit.code !== 0) {
    throw new Error(`/bin/ls to look for an ACL exited ${exit.code}: ${exit.stderr.text.trim()}`);
  }
  return exit.stdout.text.split('\n').filter((line) => line.trim() !== '').length > 1;
}
