import { posix } from 'node:path';

import { expand } from './expressions';
import type { Context } from './expressions';
import { checkDefaultsKeys, checkRunDefaultsKeys } from './keys';
import { mapping, scalar } from './parse';
import type { RunStep } from './step-plan';

/** Expand an `env:` or `with:` mapping; `field` labels its keys in diagnostics. */
export function expandMapping(
  value: unknown,
  ctx: Context,
  field: 'env' | 'with',
): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(mapping(value, field)).map(([key, item]) => {
      // No process can carry an empty variable name, so the step would never start.
      if (field === 'env' && key === '') {
        throw new Error('env has an empty key');
      }
      return [key, expand(item, ctx, `${field}.${key}`)];
    }),
  );
}

export function runDefaults(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  const defaults = mapping(value, where);
  checkDefaultsKeys(defaults, where);
  if (defaults.run === undefined) {
    return {};
  }
  const run = mapping(defaults.run, `${where}.run`);
  checkRunDefaultsKeys(run, `${where}.run`);
  return run;
}

/** Workflow-level `defaults.run`, where GitHub allows no context, so no expression either. */
export function workflowRunDefaults(value: unknown): Record<string, unknown> {
  const run = runDefaults(value, 'defaults');
  for (const [key, setting] of Object.entries(run)) {
    if (typeof setting === 'string' && setting.includes('${{')) {
      throw new Error(`expressions are not allowed in workflow defaults.run.${key}`);
    }
  }
  return run;
}

export function timeout(value: unknown, ctx: Context): number {
  const expanded = expand(value, ctx, 'timeout-minutes');
  const minutes = Number(expanded);
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(`unsupported timeout-minutes: ${expanded}`);
  }
  return minutes;
}

export function continueOnError(value: unknown, ctx: Context): boolean {
  if (value === undefined) {
    return false;
  }
  const expanded = expand(value, ctx, 'continue-on-error');
  if (expanded !== 'true' && expanded !== 'false') {
    throw new Error(`unsupported continue-on-error: ${expanded}`);
  }
  return expanded === 'true';
}

/** No `shell:` at all is GitHub's default shell, which differs from an explicit `bash`. */
export function shell(value: unknown): RunStep['shell'] {
  if (value === undefined) {
    return 'default';
  }
  if (value === 'bash' || value === 'sh') {
    return value;
  }
  throw new Error(`unsupported shell: ${JSON.stringify(value)}`);
}

/** The contract stores guest working directories relative to its workspace. */
export function workingDirectory(value: unknown, ctx: Context): string {
  const directory = expand(value, ctx, 'working-directory');
  const workspace = String(ctx.values['github.workspace']);
  return posix.isAbsolute(directory) ? posix.relative(workspace, directory) || '.' : directory;
}

/**
 * A remote action as `owner/repo[/path]@ref`, written literally. Docker and
 * local actions, `.`/`..` path segments, and expressions are rejected.
 */
export function actionReference(value: unknown): string {
  const uses = scalar(value, 'uses');
  const path = uses.slice(0, uses.indexOf('@'));
  if (
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[^\s@]+$/u.test(uses) ||
    path.split('/').some((part) => part === '.' || part === '..') ||
    uses.includes('${{')
  ) {
    throw new Error(`unsupported action reference: ${uses}`);
  }
  return uses;
}

/** GitHub-hosted runner labels whose image is Apple-silicon macOS. */
const APPLE_SILICON_LABELS = new Set(
  ['macos-latest', 'macos-14', 'macos-15', 'macos-26'].flatMap((label) => [
    label,
    `${label}-xlarge`,
  ]),
);

/**
 * Expand `runs-on` and require every label to be a known Apple-silicon macOS
 * image: Hugi's VM stands in for exactly that runner, so Intel (`-large`,
 * `-intel`, `macos-13`), unknown, and self-hosted labels fail.
 */
export function runnerLabels(value: unknown, ctx: Context): string[] {
  const labels = (Array.isArray(value) ? value : [value]).map((label) =>
    expand(label, ctx, 'runs-on'),
  );
  const unsupported = labels.filter((label) => !APPLE_SILICON_LABELS.has(label.toLowerCase()));
  if (labels.length === 0 || unsupported.length > 0) {
    throw new Error(`unsupported runs-on label: ${unsupported.join(', ')}`);
  }
  if (labels.length > 1) {
    throw new Error(`runs-on must name exactly one hosted image: ${labels.join(', ')}`);
  }
  return labels;
}
