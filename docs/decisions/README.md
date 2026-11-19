---
title: Architecture decisions
description: Index of Hugi's architecture decision records and how each status binds the work.
---
# Architecture decisions

Each record captures one decision that is hard to reverse, with its context and the alternatives it rejected.

## How a status binds

- **accepted**: load-bearing. Code and plans must comply; a violation fails review. Change it only by superseding it with a new record.
- **proposed**: the early shape of a decision. A violation is a warning that reopens the decision.
- **superseded** and **deprecated**: kept for history. They no longer bind.

## Records

| Record | Status | Decision |
| --- | --- | --- |
| [ADR-0001](0001-github-never-schedules.md) | accepted | Hugi owns scheduling; GitHub supplies commits and receives verdicts. |
| [ADR-0002](0002-verification-only.md) | accepted | Hugi runs verification lanes only, with no secrets in the VM. |
| [ADR-0003](0003-one-throwaway-vm-per-run.md) | accepted | Every run happens in a fresh VM cloned from the golden image and deleted afterwards. |
| [ADR-0004](0004-lanes-declared-in-hugi-yaml.md) | accepted | A repository declares its lanes in `.github/hugi.yaml`; promotion moves them into a Hugi workflow GitHub never runs. |
| [ADR-0005](0005-pull-requests-run-on-the-merge-commit.md) | accepted | A pull request runs on GitHub's merge commit, with the ref values GitHub's runner gives a `pull_request` job; its status goes on the head commit. |
