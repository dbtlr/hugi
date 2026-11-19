/**
 * The ref values a run sees, derived from its event in one place so the `github.*` contexts and the
 * runner's `GITHUB_*` variables cannot disagree (ADR-0005).
 */
import type { EventContext } from './step-plan';

/** What `github.ref`, `github.ref_name`, `github.ref_type`, `github.head_ref`, and `github.base_ref` hold. */
export type RefValues = {
  readonly ref: string;
  readonly refName: string;
  readonly refType: 'branch' | 'tag';
  /** The head branch's name for a pull request; empty for a push. */
  readonly headRef: string;
  /** The base branch's name for a pull request; empty for a push. */
  readonly baseRef: string;
};

/**
 * A push names its branch or tag. A pull request runs on GitHub's merge ref, `refs/pull/<n>/merge`,
 * which GitHub's runner reports as a branch named `<n>/merge`.
 */
export function refValues(event: EventContext): RefValues {
  if (event.event === 'pull_request') {
    const { baseRef, headRef, number } = event.pullRequest;
    return {
      baseRef,
      headRef,
      ref: `refs/pull/${number}/merge`,
      refName: `${number}/merge`,
      refType: 'branch',
    };
  }
  return {
    baseRef: '',
    headRef: '',
    ref: `refs/${event.refType === 'tag' ? 'tags' : 'heads'}/${event.refName}`,
    refName: event.refName,
    refType: event.refType,
  };
}
