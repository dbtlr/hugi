# CI timing spike

Throwaway scripts that measured whether macOS CI lanes run faster and more reliably on a local Apple-silicon Mac than on GitHub's hosted runners. They are kept as the starting point for the lane reader and VM lifecycle, not as production code.

## What the scripts do

| File | Purpose |
| --- | --- |
| `harness.py` | Reads one job from a workflow file at a pinned commit and runs its `run:` steps in order, timing each. `uses:` steps are not executed: checkout becomes a local clone, and setup, cache, and upload actions are skipped because toolchains are preinstalled. |
| `vm-provision.sh` | Provisions a base VM: toolchains through mise, source clones, and one priming run per lane to warm package caches. |
| `vm-run.sh` | Clones the base VM, boots it, runs one lane inside it, records timings, and deletes the VM. `VM_CPU` and `VM_MEM` set the VM size. |
| `vm-capacity.sh` | Times suspend and resume against a cold boot and finds the limit on concurrent VMs. |
| `gh-reruns.sh` | Reruns a completed GitHub Actions run on the same commit and records queue and run time for each attempt. |

The scripts expect [tart](https://tart.run), a base VM named `ci-timing-base`, and source clones under `src/` beside `harness.py`.

## Results

Measured on an Apple M4 with 10 cores and 16 GB, with macOS 15 guests.

| File | Contents |
| --- | --- |
| `github.tsv` | Five hosted attempts per lane on one commit: queue and run seconds, and whether a runner was assigned. |
| `results.tsv` | Runs directly on the host, per step: alone and four lanes at once, cold and reused checkouts. |
| `vm-results.tsv` | Runs in fresh VMs: clone, boot, and lane seconds for one VM and two VMs at once, at 2, 4, and 8 cores and at 4 GB and 8 GB. |

Findings:

- One 4-core VM reached a verdict in 79 to 407 seconds, against 254 to 902 seconds hosted. All 38 VM runs passed.
- Three of ten hosted macOS job attempts for one repository never received a runner.
- Runs directly on the host were faster still but failed under load, including a test that lost FSEvents notifications. The same test passed in every VM run.
- Four cores is the right size: two cores cost 15 to 55 percent, and eight gained under 4 percent. 4 GB of memory was enough.
- Cloning a VM took 0.1 seconds and booting it 13 to 18 seconds. Resuming a suspended VM was no faster than a cold boot.
- macOS allows two macOS guests at once. A second VM added at most 16 percent throughput.
