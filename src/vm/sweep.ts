/**
 * Delete the leftovers of a previous process: every local VM whose name starts with `prefix`.
 * The service sweeps `hugi-svc-` at startup, so a crash or SIGKILL that skipped teardown cannot
 * leak a VM for good. It touches no VM outside the prefix.
 */
import { messageOf } from '../errors';
import type { Tart } from './tart';
import { assertVmPrefix } from './vm-prefix';

export type SweepOptions = {
  /** Called with each VM just before its delete, for a log line. */
  readonly onDelete?: (vm: string) => void;
};

export type SweepResult = {
  readonly deleted: string[];
  readonly failed: { readonly vm: string; readonly message: string }[];
};

/**
 * Delete every local VM named `${prefix}*`. A delete that throws is recorded in `failed` and the
 * sweep goes on; a failed `list` throws, since nothing is known about what exists. An invalid
 * prefix throws before any tart call.
 */
export async function sweepVms(
  tart: Tart,
  prefix: string,
  options: SweepOptions = {},
): Promise<SweepResult> {
  assertVmPrefix(prefix);
  const result: SweepResult = { deleted: [], failed: [] };
  for (const vm of await tart.list()) {
    if (!vm.startsWith(prefix)) {
      continue;
    }
    options.onDelete?.(vm);
    try {
      // oxlint-disable-next-line no-await-in-loop -- one delete at a time, by design
      await tart.delete(vm);
      result.deleted.push(vm);
    } catch (error) {
      result.failed.push({ message: messageOf(error), vm });
    }
  }
  return result;
}
