import { equal } from './conditions';
import type { Value } from './expressions';
import { mapping } from './parse';
import type { LaneRef } from './step-plan';

type Scalar = string | number | boolean;
type Combination = Record<string, Scalar>;

function matrixValue(value: unknown, field: string): Scalar {
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  throw new Error(`${field} must be a string, number, or boolean`);
}

function entries(value: unknown, field: string): Combination[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be a list`);
  }
  return value.map((entry) =>
    Object.fromEntries(
      Object.entries(mapping(entry, field)).map(([key, item]) => [
        key,
        matrixValue(item, `${field}.${key}`),
      ]),
    ),
  );
}

/** Include and exclude entries match a combination on the values' written text. */
function matches(combination: Combination, partial: Combination) {
  return Object.entries(partial).every(
    ([key, value]) => Object.hasOwn(combination, key) && String(combination[key]) === String(value),
  );
}

/**
 * GitHub's matrix expansion: the axes' cross product, minus `exclude` entries,
 * then each `include` entry merged into every original combination whose
 * original axis values it does not change (it may overwrite keys an earlier
 * include added), or appended as a new combination when it merges into none.
 */
function combinations(matrix: Record<string, unknown>) {
  const axes = Object.entries(matrix).filter(([key]) => key !== 'include' && key !== 'exclude');
  let originals: Combination[] = [{}];
  for (const [key, values] of axes) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`matrix.${key} must be a nonempty list`);
    }
    const expanded: Combination[] = [];
    for (const row of originals) {
      for (const value of values) {
        expanded.push({ ...row, [key]: matrixValue(value, `matrix.${key}`) });
      }
    }
    originals = expanded;
    if (originals.length > 256) {
      throw new Error('matrix exceeds 256 combinations');
    }
  }
  const excluded = entries(matrix.exclude, 'matrix.exclude');
  originals =
    axes.length === 0
      ? []
      : originals.filter((row) => !excluded.some((item) => matches(row, item)));
  const expanded = originals.map((row) => ({ ...row }));
  for (const include of entries(matrix.include, 'matrix.include')) {
    let merged = false;
    originals.forEach((original, index) => {
      if (
        Object.entries(include).every(
          ([key, value]) => !Object.hasOwn(original, key) || matches(original, { [key]: value }),
        )
      ) {
        expanded[index] = { ...expanded[index], ...include };
        merged = true;
      }
    });
    if (!merged) {
      expanded.push(include);
    }
  }
  return expanded;
}

/** The selected values name every key of the combination, each equal by GitHub's rules. */
function selects(row: Combination, selected: LaneRef['matrix']) {
  const keys = Object.keys(selected);
  return (
    keys.length === Object.keys(row).length &&
    keys.every((key) => Object.hasOwn(row, key) && equal(row[key]!, selected[key]!))
  );
}

/**
 * The job's matrix combination the lane selects, with the values typed as the
 * workflow wrote them; empty for a job with no matrix.
 */
export function selectCombination(
  strategy: unknown,
  selected: LaneRef['matrix'],
): Readonly<Record<string, Value>> {
  const matrix = strategy === undefined ? undefined : mapping(strategy, 'strategy').matrix;
  if (matrix === undefined) {
    if (Object.keys(selected).length !== 0) {
      throw new Error('matrix values supplied for a job with no matrix');
    }
    return {};
  }
  const rows = combinations(mapping(matrix, 'strategy.matrix')).filter((row) =>
    selects(row, selected),
  );
  if (rows.length === 0) {
    throw new Error(`matrix values do not select a combination: ${JSON.stringify(selected)}`);
  }
  if (rows.length > 1) {
    throw new Error(`matrix values select more than one combination: ${JSON.stringify(selected)}`);
  }
  return rows[0]!;
}
