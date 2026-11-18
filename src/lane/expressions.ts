import { scalar } from './parse';

/** A workflow expression value, typed as GitHub's expression language types it. */
export type Value = string | number | boolean | null;

/**
 * What one place in a workflow can read: the values its expressions resolve
 * to, and the context names (`env`) or full expressions (`github.ref`) it must
 * not read, each with the reason the read fails.
 */
export type Context = {
  readonly values: Readonly<Record<string, Value>>;
  readonly unavailable: Readonly<Record<string, string>>;
};

function unavailableReason(expression: string, ctx: Context): string | undefined {
  const root = expression.split('.')[0]!;
  return ctx.unavailable[expression] ?? ctx.unavailable[root];
}

export function resolve(expression: string, ctx: Context): Value {
  const reason = unavailableReason(expression, ctx);
  if (reason !== undefined) {
    throw new Error(`${expression} is not available: ${reason}`);
  }
  if (Object.hasOwn(ctx.values, expression)) {
    return ctx.values[expression]!;
  }
  if (/^needs\.[\w-]+\.(?:outputs\.[\w-]+|result)$/u.test(expression)) {
    throw new Error(`missing upstream value ${expression}`);
  }
  throw new Error(`unsupported expression: ${expression}`);
}

/** GitHub's string form of a value: null interpolates as the empty string. */
export function text(value: Value): string {
  return value === null ? '' : String(value);
}

export function expand(value: unknown, ctx: Context, field: string): string {
  const expanded = scalar(value, field).replace(
    /\$\{\{\s*([\s\S]*?)\s*\}\}/gu,
    (_match, expression: string) => text(resolve(expression.trim(), ctx)),
  );
  if (expanded.includes('${{')) {
    throw new Error(`unsupported expression in ${field}: ${expanded}`);
  }
  return expanded;
}
