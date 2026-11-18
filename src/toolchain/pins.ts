import { ToolchainResolutionError } from './errors';

export type Pins = Map<string, { readonly spec: string; readonly source: string }>;

export function addPin(pins: Pins, spec: string, source: string) {
  const tool = spec.slice(0, spec.indexOf('@'));
  const previous = pins.get(tool);
  if (previous !== undefined && previous.spec !== spec) {
    throw new ToolchainResolutionError(
      `${source}: conflicting ${tool} pins: ${previous.spec} from ${previous.source}, ${spec}`,
    );
  }
  if (previous === undefined) {
    pins.set(tool, { source, spec });
  }
}
