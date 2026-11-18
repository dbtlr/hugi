---
type: adr
title: ADR-0003 - One throwaway VM per run
description: Every run happens in a fresh VM cloned from the golden image and deleted on every exit path. Nothing from a pull request runs on the host.
status: accepted
created: 2026-11-18
modified: 2026-11-18
---
# ADR-0003 - One throwaway VM per run

## Context

Measured on the host machine, running a lane on the bare host was faster than in a VM but less reliable. One repository lost filesystem change notifications while settling test fixtures in 3 of 5 executions, two of them under load and one alone in a reused checkout, and another failed a timing assertion under load. The same lanes passed in every VM run. Running pull-request code directly on the host would also give that code the host's files and credentials.

## Decision

Every run happens in a VM cloned from the golden image for that run alone. The VM is deleted when the run ends, on every exit path: success, failure, timeout, and interruption. The host clones, boots, and deletes VMs, and collects the logs a run leaves, which it treats as data. It never executes a lane's steps. VMs use tart on Apple's Virtualization framework.

## Considered options

- **Run on the bare host.** It was faster, but it produced false failures, mostly under load, and gives pull-request code the host.
- **Keep VMs suspended and reuse them.** Resuming a suspended VM was no faster than a cold boot of a fresh clone, and reuse would carry state between runs.
- **Reuse a warm checkout.** It saved 4 to 27 percent, but the lanes are bound by test time, and a fresh clone keeps runs independent.

## Consequences

Cloning takes about 0.1 seconds and booting 13 to 18 seconds, which every run pays. macOS allows only two macOS VMs at once, so at most two runs can proceed in parallel. The starting configuration is one run at a time in a VM of 4 cores and 4 GB, the size the measurements supported; both are tunable settings, not part of this decision. Toolchains and package caches must be in the golden image for runs to start warm.
