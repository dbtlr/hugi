/** What a `<repository>` argument names: a public GitHub repository, or a git repository on this host. */
import { basename, resolve } from 'node:path';

import { expandHome } from './locations';

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
    return { kind: 'local', path: resolve(cwd, expandHome(text, home)) };
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

/**
 * An enrolled repository as a GitHub source. Enrolment admits only `owner/name`, so anything else
 * is a bug and throws.
 */
export function githubRepositorySpec(repository: string): GitHubRepositorySpec {
  const spec = GITHUB_NAME.test(repository) ? parseRepository(repository, '/', '/') : undefined;
  if (spec?.kind !== 'github') {
    throw new RepositorySpecError(`"${repository}" is not an owner/name GitHub repository.`);
  }
  return spec;
}

/** The `github.repository` a run sees: the GitHub name, else `local/<directory>` for a local path. */
export function repositoryLabel(spec: RepositorySpec): string {
  return spec.kind === 'github' ? spec.name : `local/${basename(spec.path)}`;
}
