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
 * The key two status names are compared by. GitHub treats contexts that differ only in case as
 * one, so a verdict posted as `HUGI / BUILD` settles `hugi / build`, and two lanes may not have
 * names that differ only in case. The name is upper-cased before it is lower-cased so that every
 * case variant of a letter folds to one key: lower-casing alone keeps `σ` and `ς` (the lower case
 * of a word-final `Σ`) apart, and keeps `ß` apart from `SS`.
 */
export function statusNameKey(name: string): string {
  return name.toUpperCase().toLowerCase();
}
