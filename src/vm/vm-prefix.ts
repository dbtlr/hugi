/**
 * The rule for the VM name prefixes Hugi owns. Hugi creates and deletes only VMs named `hugi-*`;
 * a prefix such as `hugi-run-` (one run's VM) or `hugi-svc-` (the service's VM) must match this
 * rule, so a typo cannot widen a sweep or a clone to a VM that belongs to someone else.
 */
const VM_PREFIX_PATTERN = /^hugi-[a-z]+-$/;

/** Throw unless `prefix` is `hugi-`, lowercase letters, and a closing dash. */
export function assertVmPrefix(prefix: string): void {
  if (!VM_PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `VM name prefix ${JSON.stringify(prefix)} is not allowed: it must match ${VM_PREFIX_PATTERN.source}`,
    );
  }
}
