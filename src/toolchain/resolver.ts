import type { StepPlan } from '../lane/step-plan';
import { resolveAction } from './actions';
import { addPin } from './pins';
import type { Pins } from './pins';
import { resolveRust } from './rust';
import type { ReadRepoFile, ToolchainResolution } from './types';

export { ToolchainResolutionError, UnsupportedActionError } from './errors';
export type { ActionResolution, ReadRepoFile, ToolchainResolution } from './types';

/** Resolve the entire lane before exposing tools to the VM runner. */
export async function resolveToolchains(
  plan: StepPlan,
  readRepoFile: ReadRepoFile,
): Promise<ToolchainResolution> {
  const actions = await Promise.all(
    plan.steps
      .filter((step) => step.kind === 'action')
      .map((step) => resolveAction(step, readRepoFile)),
  );
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
