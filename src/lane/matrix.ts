import { equal } from './conditions';
import { LaneSelectionError } from './errors';
import type { Value } from './expressions';
import { emptyMap, isPrototypeKey } from './names';
import { mapping } from './parse';
import type { LaneRef } from './step-plan';

export type Scalar = string | number | boolean;
export type Combination = Record<string, Scalar>;

function matrixValue(value: unknown, field: string): Scalar {
  // Hugi does not evaluate expressions, so a value built by one would become literal text.
  if (typeof value === 'string' && value.includes('${{')) {
    throw new Error(`${field} holds an expression, which cannot be expanded`);
  }
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
  const axes = Object.entries(matrix)
    .filter(([key]) => key !== 'include' && key !== 'exclude')
    .map(([key, values]): [string, unknown[]] => {
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(`matrix.${key} must be a nonempty list`);
      }
      return [key, values];
    });
  checkKeyCount(axes.length);
  // Checked before any row is built, so a huge axis costs nothing.
  checkSize(axes.reduce((product, [, values]) => product * values.length, 1));
  const typed = axes.map(([key, values]) =>
    values.map((value) => matrixValue(value, `matrix.${key}`)),
  );
  let originals = crossProduct(
    axes.map(([key]) => key),
    typed,
  );
  const excluded = entries(matrix.exclude, 'matrix.exclude');
  const included = entries(matrix.include, 'matrix.include');
  checkListLength(excluded, 'matrix.exclude');
  checkListLength(included, 'matrix.include');
  checkKeyCount(new Set([...axes.map(([key]) => key), ...included.flatMap(Object.keys)]).size);
  originals =
    axes.length === 0
      ? []
      : originals.filter((row) => !excluded.some((item) => matches(row, item)));
  const expanded = originals.map((row) => ({ ...row }));
  for (const include of included) {
    let merged = false;
    originals.forEach((original, index) => {
      if (
        Object.entries(include).every(
          ([key, value]) => !Object.hasOwn(original, key) || matches(original, { [key]: value }),
        )
      ) {
        mergeInto(expanded[index]!, include);
        merged = true;
      }
    });
    if (!merged) {
      expanded.push(include);
    }
  }
  checkSize(expanded.length);
  const order = [...new Set([...axes.map(([key]) => key), ...included.flatMap(Object.keys)])];
  return expanded.map((row) => inKeyOrder(row, order));
}

/**
 * The row with its keys in `order`, the order the workflow lists them: its axes, then the keys
 * its include entries add, as each first appears. An appended include entry is written in its own
 * order, and a lane's status name lists the row's values in the workflow's order.
 */
function inKeyOrder(row: Combination, order: readonly string[]): Combination {
  // `fromEntries` defines each key, so a `__proto__` key stays an own key.
  return Object.fromEntries(
    order.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]!]),
  );
}

/**
 * Merge an include entry into a row that is this function's own copy, in place, so a merge costs
 * the entry's keys and not a copy of the row. Each key is defined, not assigned, so a key such as
 * `__proto__` stays an own key, as it does in a row an include appends.
 */
function mergeInto(row: Combination, include: Combination) {
  for (const [key, value] of Object.entries(include)) {
    Object.defineProperty(row, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
}

/**
 * The cross product of the axes, the first axis varying slowest as GitHub orders it. Each row is
 * built once from its values, so the cost is rows times axes, not a copy of every row per axis.
 */
function crossProduct(keys: readonly string[], values: readonly Scalar[][]): Combination[] {
  const total = values.reduce((product, axis) => product * axis.length, 1);
  return Array.from({ length: total }, (_, index) => {
    let rest = index;
    const picked = Array.from<Scalar>({ length: keys.length });
    for (let axis = keys.length - 1; axis >= 0; axis -= 1) {
      const axisValues = values[axis]!;
      picked[axis] = axisValues[rest % axisValues.length]!;
      rest = Math.floor(rest / axisValues.length);
    }
    return Object.fromEntries(keys.map((key, axis) => [key, picked[axis]!]));
  });
}

/** The most keys one matrix may have, counting its axes and the keys its include entries add. */
export const MAX_MATRIX_KEYS = 256;

function checkKeyCount(count: number) {
  if (count > MAX_MATRIX_KEYS) {
    throw new Error(`matrix has ${count} keys, more than the ${MAX_MATRIX_KEYS} a matrix may have`);
  }
}

/**
 * The most entries a matrix's `include` or `exclude` list may have. Each entry is matched against
 * every row, so the cap bounds the cost of expanding the matrix on the host.
 */
export const MAX_MATRIX_LIST_ENTRIES = 256;

function checkListLength(list: readonly Combination[], field: string) {
  if (list.length > MAX_MATRIX_LIST_ENTRIES) {
    throw new Error(
      `${field} has ${list.length} entries, more than the ${MAX_MATRIX_LIST_ENTRIES} it may have`,
    );
  }
}

/** GitHub runs at most 256 jobs from one matrix, counting rows that `include` adds. */
function checkSize(count: number) {
  if (count > 256) {
    throw new Error(`matrix has ${count} combinations, more than 256`);
  }
}

/**
 * A selected value equals the row's by GitHub's rules. A boolean also matches its written text,
 * since `--matrix enabled=true` supplies a string that GitHub's numeric coercion would never
 * equate with `true`.
 */
export function matchesValue(value: Scalar, wanted: Scalar): boolean {
  return equal(value, wanted) || (typeof value === 'boolean' && String(value) === String(wanted));
}

/** The selected values name every key of the combination, each matching its value. */
function selects(row: Combination, selected: LaneRef['matrix']) {
  const keys = Object.keys(selected);
  return (
    keys.length === Object.keys(row).length &&
    keys.every((key) => Object.hasOwn(row, key) && matchesValue(row[key]!, selected[key]!))
  );
}

/**
 * Every combination of the job's matrix as GitHub expands it, with the values typed as the
 * workflow wrote them; `undefined` for a job with no matrix. Throws when the matrix is not a
 * literal one: a matrix, an axis, or an axis, include, or exclude value built by an expression.
 */
export function matrixRows(strategy: unknown): readonly Combination[] | undefined {
  const matrix = strategy === undefined ? undefined : mapping(strategy, 'strategy').matrix;
  return matrix === undefined ? undefined : combinations(mapping(matrix, 'strategy.matrix'));
}

/**
 * The combination of `all` the lane selects, with the values typed as the workflow wrote them;
 * empty when the job has no matrix (`all` is `undefined`).
 */
export function selectRow(
  all: readonly Combination[] | undefined,
  selected: LaneRef['matrix'],
): Readonly<Record<string, Value>> {
  if (all === undefined) {
    if (Object.keys(selected).length !== 0) {
      throw new LaneSelectionError('matrix values supplied for a job with no matrix');
    }
    return {};
  }
  const rows = all.filter((row) => selects(row, selected));
  if (rows.length === 0) {
    throw new LaneSelectionError(
      `matrix values do not select a combination: ${JSON.stringify(selected)}`,
    );
  }
  if (rows.length > 1) {
    throw new LaneSelectionError(
      `matrix values select more than one combination: ${JSON.stringify(selected)}`,
    );
  }
  return rows[0]!;
}

/** Why a `key=value` matrix entry list is refused; each reader words it for its own audience. */
export type MatrixEntryProblem =
  | { readonly kind: 'not-key-value'; readonly entry: string }
  | { readonly kind: 'reserved-key'; readonly key: string; readonly entry: string }
  | { readonly kind: 'repeated-key'; readonly key: string };

export type MatrixEntries =
  | { readonly matrix: Record<string, string> }
  | { readonly problem: MatrixEntryProblem };

/**
 * Parse `key=value` entries, split at the first equals sign. Values stay strings; the lane reader
 * compares them as GitHub does. The map has no prototype, so no key reaches `Object.prototype`.
 */
export function readMatrixEntries(written: readonly string[]): MatrixEntries {
  const matrix = emptyMap<string>();
  for (const entry of written) {
    const equals = entry.indexOf('=');
    if (equals <= 0) {
      return { problem: { entry, kind: 'not-key-value' } };
    }
    const key = entry.slice(0, equals);
    if (isPrototypeKey(key)) {
      return { problem: { entry, key, kind: 'reserved-key' } };
    }
    if (Object.hasOwn(matrix, key)) {
      return { problem: { key, kind: 'repeated-key' } };
    }
    matrix[key] = entry.slice(equals + 1);
  }
  return { matrix };
}
