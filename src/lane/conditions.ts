import { withContext } from './errors';
import { resolve, text } from './expressions';
import type { Context, Value } from './expressions';
import { scalar } from './parse';
import type { StepWhen } from './step-plan';

// Evaluate against success, failure, and cancellation to reject unrepresentable guards.
type Values = readonly [Value, Value, Value];

/** What each status function (`success()`, `failure()`, …) returns in one place. */
type StatusFunctions = Readonly<Record<string, Values>>;

/** In a step, status functions depend on the run-time state of earlier steps. */
const STEP_STATUS: StatusFunctions = {
  always: [true, true, true],
  cancelled: [false, false, true],
  failure: [false, true, false],
  success: [true, false, false],
};

function tokens(source: string): string[] {
  const pattern =
    /\s*('(?:[^']|'')*'|\d+(?:\.\d+)?|[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*|&&|\|\||==|!=|[!(),])/gy;
  const result: string[] = [];
  let offset = 0;
  while (offset < source.trimEnd().length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match) {
      throw new Error(`unexpected syntax at ${source.slice(offset)}`);
    }
    result.push(match[1]!);
    offset = pattern.lastIndex;
  }
  return result;
}

function truthy(value: Value): boolean {
  return Boolean(value);
}

/** GitHub compares strings without case, and coerces unlike scalar types to numbers. */
export function equal(left: Value, right: Value): boolean {
  if (typeof left === 'string' && typeof right === 'string') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return typeof left === typeof right ? left === right : Number(left) === Number(right);
}

function combine(left: Values, right: Values, operation: (a: Value, b: Value) => Value): Values {
  return [operation(left[0], right[0]), operation(left[1], right[1]), operation(left[2], right[2])];
}

function parse(source: string, ctx: Context, status: StatusFunctions) {
  const input = tokens(source);
  let offset = 0;
  let hasStatus = false;

  function take(expected: string) {
    if (input[offset] !== expected) {
      throw new Error(`expected ${expected}`);
    }
    offset += 1;
  }

  function primary(): Values {
    const token = input[offset++];
    if (token === undefined) {
      throw new Error('expected a value');
    }
    if (token === '(') {
      const value = or();
      take(')');
      return value;
    }
    if (token.startsWith("'")) {
      const value = token.slice(1, -1).replaceAll("''", "'");
      return [value, value, value];
    }
    if (input[offset] === '(') {
      take('(');
      if (token === 'startsWith') {
        const left = or();
        take(',');
        const right = or();
        take(')');
        return combine(left, right, (a, b) =>
          text(a).toLowerCase().startsWith(text(b).toLowerCase()),
        );
      }
      take(')');
      if (!Object.hasOwn(status, token)) {
        throw new Error(`unsupported function ${token}`);
      }
      hasStatus = true;
      return status[token]!;
    }
    let value: Value;
    if (token === 'true') {
      value = true;
    } else if (token === 'false') {
      value = false;
    } else if (token === 'null') {
      value = null;
    } else if (/^\d/u.test(token)) {
      value = Number(token);
    } else {
      value = resolve(token, ctx);
    }
    return [value, value, value];
  }

  function unary(): Values {
    if (input[offset] !== '!') {
      return primary();
    }
    offset += 1;
    const value = unary();
    return [!truthy(value[0]), !truthy(value[1]), !truthy(value[2])];
  }

  function comparison(): Values {
    let value = unary();
    while (input[offset] === '==' || input[offset] === '!=') {
      const operator = input[offset++];
      value = combine(value, unary(), (a, b) => (operator === '==' ? equal(a, b) : !equal(a, b)));
    }
    return value;
  }

  function and(): Values {
    let value = comparison();
    while (input[offset] === '&&') {
      offset += 1;
      value = combine(value, comparison(), (a, b) => (truthy(a) ? b : a));
    }
    return value;
  }

  function or(): Values {
    let value = and();
    while (input[offset] === '||') {
      offset += 1;
      value = combine(value, and(), (a, b) => (truthy(a) ? a : b));
    }
    return value;
  }

  const values = or();
  if (offset !== input.length) {
    throw new Error(`unexpected token ${input[offset]}`);
  }
  return { hasStatus, values };
}

function evaluate(value: unknown, ctx: Context, status: StatusFunctions) {
  const source = scalar(value, 'if').trim();
  try {
    return parse(source.replace(/^\$\{\{([\s\S]*)\}\}$/u, '$1').trim(), ctx, status);
  } catch (cause) {
    throw conditionError(source, cause);
  }
}

function conditionError(source: string, cause: unknown) {
  return withContext(`unsupported condition "${source}"`, cause);
}

/** Reduce a step's `if:` to the run-time state the plan can express, or null to drop the step. */
export function stepCondition(value: unknown, ctx: Context): StepWhen | null {
  if (value === undefined) {
    return 'success';
  }
  const { values, hasStatus } = evaluate(value, ctx, STEP_STATUS);
  const [success, failure, cancelled] = values.map(truthy);
  if (!hasStatus) {
    return success ? 'success' : null;
  }
  if (!success && !failure && !cancelled) {
    return null;
  }
  if (success && failure) {
    return 'always';
  }
  if (success && !failure && !cancelled) {
    return 'success';
  }
  if (!success && failure && !cancelled) {
    return 'failure';
  }
  throw conditionError(
    scalar(value, 'if').trim(),
    new Error('cannot reduce to success, failure, or always'),
  );
}

/** The upstream job results a job-level `if:` sees through its status functions. */
export type Upstream = { readonly allSucceeded: boolean; readonly anyFailed: boolean };

/**
 * Decide a job-level `if:`. Status functions read the jobs in `needs:`, and an
 * `if:` without one gets GitHub's implicit `success()`.
 */
export function jobRuns(value: unknown, ctx: Context, upstream: Upstream): boolean {
  if (value === undefined) {
    return upstream.allSucceeded;
  }
  const status: StatusFunctions = {
    always: [true, true, true],
    cancelled: [false, false, false],
    failure: [upstream.anyFailed, upstream.anyFailed, upstream.anyFailed],
    success: [upstream.allSucceeded, upstream.allSucceeded, upstream.allSucceeded],
  };
  const { values, hasStatus } = evaluate(value, ctx, status);
  return truthy(values[0]) && (hasStatus || upstream.allSucceeded);
}
