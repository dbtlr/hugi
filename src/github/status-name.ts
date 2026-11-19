/**
 * The names of the commit statuses Hugi posts. A lane's status is named from its identity alone
 * (ADR-0004), its job id and matrix row, so promotion, which moves the job to another file, keeps
 * the name branch protection requires.
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
