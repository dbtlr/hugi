# Hugi

Hugi runs macOS CI lanes on your own Mac and reports the verdicts to GitHub.

It polls GitHub for new commits, runs each macOS job in a throwaway virtual machine, and posts the result as a commit status. GitHub's hosted macOS runners are not involved, so a pull request cannot fail because a runner never arrived.

> **Status:** design agreed, build not started. The only code here is the measurement spike in [`spike/ci-timing`](spike/ci-timing).

## Why

Hosted macOS runners are slow to arrive and sometimes do not arrive at all. In one measurement, five attempts at the same commit produced three macOS jobs that waited 15 to 25 minutes, never received a runner, and were cancelled. The same lanes ran in a local VM in one to seven minutes and passed every time.

## Principles

- **GitHub supplies commits and receives verdicts; it never schedules.** No run waits on a GitHub runner.
- **The workflow file is the only definition of a lane.** Hugi executes a job's `run:` steps as written and never restates them.
- **Nothing from a pull request touches the host.** Every run happens in a VM cloned for that run and deleted afterwards.
- **The repository says what to run; Hugi's configuration says who may run.** Enrolled repositories and allowlisted authors live outside the repositories.
- **Verification only.** The VM holds no secret and publishes nothing.
- **Reconcile from GitHub's state.** The queue is derived from the commits that lack a verdict, so a restart heals itself.
- **A local verdict earns authority.** It starts advisory and becomes a required check only after it has matched the hosted verdict over a clean stretch.

## How it works

| Part | What it does |
| --- | --- |
| Poller | Reads the head commit of the default branch and of open pull requests for each enrolled repository. Skips authors that are not allowlisted. |
| Queue | Holds lanes that have no verdict for their commit. One VM runs at a time. |
| Lane reader | Reads the named job from the workflow file at the commit and runs its `run:` steps in order. Maps known setup actions to toolchains preinstalled in the image. |
| VM lifecycle | Clones a golden image, boots it, runs the lane, collects logs, and deletes the VM. Uses [tart](https://tart.run) on Apple's Virtualization framework. |
| Reporter | Posts a commit status for each lane. |

## Plan

1. Run one lane by hand: a command that takes a repository, commit, and lane, and returns a verdict with logs.
2. Run the coordinator in shadow: polling, allowlist, queue, and advisory commit statuses.
3. Compare verdicts with the hosted runners, then promote one repository at a time.
4. Harden operations: scheduled image refresh, outage alerts, more repositories.

## License

[MIT](LICENSE)
