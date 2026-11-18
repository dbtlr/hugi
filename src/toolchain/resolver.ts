import type { StepPlan } from '../lane/step-plan';
import { resolveAction } from './actions';
import { addPin } from './pins';
import type { Pins } from './pins';
import { resolveRust } from './rust';
import type { ReadRepoFile, ToolchainResolution } from './types';

export { ToolchainResolutionError, UnsupportedActionError } from './errors';
export type { ActionResolution, ReadRepoFile, ToolchainResolution } from './types';

/**
 * Every action's resolution, or the first failure in step order. All of them settle first, so
 * every repository read has finished, and been seen by the reader, whichever fails.
 */
async function resolveActions(plan: StepPlan, readRepoFile: ReadRepoFile) {
  const settled = await Promise.allSettled(
    plan.steps
      .filter((step) => step.kind === 'action')
      .map((step) => resolveAction(step, readRepoFile)),
  );
  return settled.map((outcome) => {
    if (outcome.status === 'rejected') {
      throw outcome.reason;
    }
    return outcome.value;
  });
}

/** Resolve the entire lane before exposing tools to the VM runner. */
export async function resolveToolchains(
  plan: StepPlan,
  readRepoFile: ReadRepoFile,
): Promise<ToolchainResolution> {
  const actions = await resolveActions(plan, readRepoFile);
  const pins: Pins = new Map();
  for (const action of actions) {
    if (action.kind === 'tools') {
      for (const spec of action.tools) {
        addPin(pins, spec, `step ${action.index} "${action.name}" (${action.uses})`);
      }
    }
  }
  const rust = await resolveRust(readRepoFile);
  const notes: string[] = [];
  if (rust !== undefined) {
    addPin(pins, rust.tool, rust.source);
    notes.push(rust.note);
  }
  return { actions, notes, tools: [...pins.values()].map(({ spec }) => spec) };
}
