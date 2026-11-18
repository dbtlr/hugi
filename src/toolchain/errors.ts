import type { ActionStep } from '../lane/step-plan';

export class ToolchainResolutionError extends Error {
  override readonly name: string = 'ToolchainResolutionError';
}

export class UnsupportedActionError extends ToolchainResolutionError {
  override readonly name = 'UnsupportedActionError';

  constructor(step: ActionStep, reason: string) {
    super(`step ${step.index} "${step.name}" (${step.uses}): ${reason}`);
  }
}
