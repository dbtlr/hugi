/** What a `<repository>` argument names: a public GitHub repository, or a git repository on this host. */
import { basename, resolve } from 'node:path';

export type RepositorySpec =
  | { readonly kind: 'github'; readonly name: string; readonly cloneUrl: string }
  | { readonly kind: 'local'; readonly path: string };

/** A repository on GitHub: the only kind that has pull requests. */
export type GitHubRepositorySpec = Extract<RepositorySpec, { kind: 'github' }>;

const GITHUB_NAME = /^[\w.-]+\/[\w.-]+$/;
const EXPLICIT_PATH = /^(\/|\.{1,2}(\/|$)|~)/;

export class RepositorySpecError extends Error {
  override readonly name = 'RepositorySpecError';
}

/**
 * `owner/name` is GitHub; a path starting with `/`, `./`, `../`, or `~` is local.
 * Anything else is ambiguous, so it is refused rather than guessed.
 */
export function parseRepository(text: string, cwd: string, home: string): RepositorySpec {
  if (EXPLICIT_PATH.test(text)) {
    const expanded = text.startsWith('~') ? home + text.slice(1) : text;
    return { kind: 'local', path: resolve(cwd, expanded) };
  }
  if (GITHUB_NAME.test(text)) {
    const name = text.replace(/\.git$/, '');
    // `.` and `..` would make the clone and API URLs name another path.
    if (!name.split('/').some((part) => part === '.' || part === '..')) {
      return { cloneUrl: `https://github.com/${name}.git`, kind: 'github', name };
    }
  }
  throw new RepositorySpecError(
    `"${text}" is neither owner/name nor a path; start a local path with ./ or /.`,
  );
}

/** The `github.repository` a run sees: the GitHub name, else `local/<directory>` for a local path. */
export function repositoryLabel(spec: RepositorySpec): string {
  return spec.kind === 'github' ? spec.name : `local/${basename(spec.path)}`;
}
