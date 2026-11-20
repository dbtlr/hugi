/**
 * The names of the commit statuses Hugi posts. A lane's status is named from its identity
 * (ADR-0004), its job id and matrix row, and not from its workflow path. Promotion, which moves
 * the job to another file, keeps the name branch protection requires as long as the Hugi workflow
 * lists the job's matrix keys in the original order, because the name lists the row's values in
 * that order.
 */
import type { LaneRef } from '../lane/step-plan';

/** The status that reports a refused lane declaration on a commit. */
export const DECLARATION_STATUS = 'hugi';

/**
 * `hugi / <job id>`, or `hugi / <job id> (<values>)` for a lane with a matrix row: the row's
 * values only, comma-and-space separated, in the order the workflow lists its matrix keys, except
 * that a key that looks like an integer, such as `'2'`, comes first, because JavaScript orders such
 * object keys first. The name is still stable for a lane, and the declaration reader refuses two
 * lanes whose names collide, so it is unique among a commit's lanes.
 */
export function laneStatusName(lane: LaneRef): string {
  const values = Object.values(lane.matrix).map(String);
  const name = `${DECLARATION_STATUS} / ${lane.job}`;
  return values.length === 0 ? name : `${name} (${values.join(', ')})`;
}

/**
 * The key two status names are compared by. On 2026-11-19 GitHub was observed to merge contexts
 * the way MySQL's `utf8mb4_general_ci` collation would: case is ignored (`İstanbul` and
 * `istanbul`, `Ǆ` and `ǆ`), accents are ignored (`café` and `cafe`), `ß` equals `s` (`straße` and
 * `strase`), and trailing spaces are ignored. GitHub kept `straße` and `STRASSE`, `ﬁx` and `fix`,
 * `ı` and `i`, and fullwidth `Ａ` and `a` apart. It also refuses with 422 any character outside
 * the Basic Multilingual Plane, an emoji for one, in a status name. The key should not be narrower
 * than GitHub's comparison, because two names GitHub merges would then post as one context. It is
 * used to refuse lanes whose names collide and by the poller to settle a lane from the statuses on
 * a commit (`src/queue/derive.ts`), so a broader key refuses more lanes and can also let a status
 * GitHub keeps apart (`ı` against `i`) settle a lane; that is accepted. So the name is decomposed
 * (NFD) with its combining marks dropped, `ß` and `ẞ` become `s`, trailing spaces are trimmed, and
 * the result is lower-cased, upper-cased, then
 * lower-cased again so that every case variant of a letter folds to one key: lower-casing alone
 * keeps `σ` and `ς` apart. The fold errs toward merging where GitHub does not: `ﬁ` folds with `fi`
 * and the dotless `ı` with `i`.
 */
export function statusNameKey(name: string): string {
  const plain = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[ßẞ]/gu, 's')
    .replace(/ +$/u, '');
  return plain.toLowerCase().toUpperCase().toLowerCase();
}

const NON_BMP = /[\u{10000}-\u{10FFFF}]/u;

/** Whether `text` has a character outside the Basic Multilingual Plane, which GitHub refuses in a status. */
export function hasNonBmp(text: string): boolean {
  return NON_BMP.test(text);
}

/** `text` with each character outside the BMP replaced by U+FFFD. */
export function withoutNonBmp(text: string): string {
  return text.replace(/[\u{10000}-\u{10FFFF}]/gu, '\uFFFD');
}

/**
 * `text` as a description may carry it: each character outside the BMP, and each lone surrogate
 * (half of a pair, which no encoding can write), becomes U+FFFD. Every character is then one UTF-16
 * unit, so a length count is a character count and a cut never splits a pair.
 */
export function wellFormedBmp(text: string): string {
  return withoutNonBmp(text).toWellFormed();
}
