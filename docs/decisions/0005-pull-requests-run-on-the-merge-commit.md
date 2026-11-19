---
type: adr
title: ADR-0005 - A pull request runs on GitHub's merge commit
description: A pull-request run checks out the merge commit GitHub keeps at refs/pull/<n>/merge, after checking it merges the head Hugi was asked to run, and sees the ref values GitHub's runner gives a pull_request job. Its status is posted on the head commit.
status: accepted
created: 2026-11-19
modified: 2026-11-19
---
# ADR-0005 - A pull request runs on GitHub's merge commit

## Context

A lane's verdict must match GitHub's. For a `pull_request` event, GitHub does not run the pull request's head commit. It runs a merge of the head into the base branch, which it computes in the background and keeps at `refs/pull/<n>/merge`, and `actions/checkout` checks out that commit by default. The merge commit's first parent is the base branch's tip and its second parent is the head. GitHub runs no `pull_request` workflow while the pull request has a merge conflict, because there is then no merge commit. Every open pull request also has `refs/pull/<n>/head`, and both refs can be fetched anonymously over https from a public repository. Neither ref records the head or base branch's name; GitHub's API does.

The runner's view of a `pull_request` job:

- `GITHUB_SHA` is the merge commit, `GITHUB_REF` is `refs/pull/<n>/merge`, `GITHUB_REF_NAME` is `<n>/merge`, and `GITHUB_REF_TYPE` is `branch`.
- `GITHUB_HEAD_REF` and `GITHUB_BASE_REF` are the names of the head and base branches. The `github.head_ref` and `github.base_ref` contexts hold the same values. For other events they are empty.

Branch protection counts a required status on the pull request's head commit.

[ADR-0004](0004-lanes-declared-in-hugi-yaml.md) reads the lane declaration and the workflow files at the commit that stands for a pull request, and left open which commit that is.

## Decision

### The commit

A pull-request run checks out GitHub's merge commit. Hugi learns the pull request's number, head commit, head branch, and base branch from GitHub's API. On the host, it fetches `refs/pull/<n>/head` and `refs/pull/<n>/merge` and uses the merge commit only when all of these hold:

- `refs/pull/<n>/head` is the head commit the API reported;
- the merge commit has exactly two parents;
- its second parent is that head commit.

Otherwise the pull request is not ready to run, and Hugi gives no verdict. The reason is named: the merge ref is missing, because the pull request is closed or has a conflict, or GitHub has not yet computed the merge, or the merge or head ref no longer matches the head commit, because GitHub has not recomputed the merge since the last push or the pull request moved while Hugi read it. The coordinator considers the pull request again at its next poll; `hugi run` exits with no verdict.

The lane declaration and the workflow files are read at the merge commit, and the VM checks it out. The run's verdict belongs to the head commit, and its status is posted there.

### The values the run sees

For a pull-request run, the `github.*` contexts and the environment of every step hold:

| Variable | Context | Value |
| --- | --- | --- |
| `GITHUB_EVENT_NAME` | `github.event_name` | `pull_request` |
| `GITHUB_SHA` | `github.sha` | the merge commit |
| `GITHUB_REF` | `github.ref` | `refs/pull/<n>/merge` |
| `GITHUB_REF_NAME` | `github.ref_name` | `<n>/merge` |
| `GITHUB_REF_TYPE` | `github.ref_type` | `branch` |
| `GITHUB_HEAD_REF` | `github.head_ref` | the head branch's name |
| `GITHUB_BASE_REF` | `github.base_ref` | the base branch's name |

For a `push` run, `GITHUB_HEAD_REF`, `GITHUB_BASE_REF`, `github.head_ref`, and `github.base_ref` are empty strings, and the other values stay as they are. The event payload, `github.event.*` and `GITHUB_EVENT_PATH`, is still not supplied: a lane that reads it fails as before.

The event contract carries these facts. A `pull_request` event holds the pull request's number, head commit, head branch, and base branch, and its `sha` is the merge commit. A `push` event holds the ref type and name, as before.

### Running a pull request by hand

`hugi run <owner/name> pull/<n> <lane>` runs a lane for pull request `<n>`. Hugi makes one anonymous call to GitHub's API for the pull request's head commit and branches, then resolves the merge commit as the coordinator does. A local repository has no pull requests and refuses `pull/<n>`. `--event pull_request` without `pull/<n>`, `--event push` with it, and `--ref-type` or `--ref-name` with it are usage errors, because none of them can describe a faithful pull-request run.

## Considered options

- **Run the head commit.** It needs no merge and no wait after a push, but the run is not the commit GitHub tests. The declaration and the workflows come from the branch alone, so a branch older than a promotion reads the old workflow and declaration and posts no status for a promoted lane.
- **Compute the merge on the host.** Hugi would need the blobs and a merge on the host, over pull-request content, and its merge could differ from GitHub's on edge cases such as conflicts. It gains nothing over the merge GitHub already keeps.
- **Name a pull-request run with flags.** `--pr`, `--head-ref`, and `--base-ref` beside the merge commit's sha would need no API call and would work on a local repository. Nothing would check that the commit belongs to the pull request, and a person would have to look up the merge commit and both branches by hand.

## Consequences

- A pull-request run waits until GitHub has computed the merge for the latest push. The wait is usually seconds; the coordinator absorbs it by polling again.
- A conflicting pull request has no run and no status, as on GitHub. After promotion its required status stays pending until the conflict is resolved, as a hosted check does.
- The merge commit's base is the base branch's tip when Hugi reads the ref, which can be newer than the tip when GitHub ran its own workflow. A pull request runs once per head commit: a base branch that moves while the head stays put starts no new run, as on GitHub.
- A branch that predates a repository's enrolment or promotion still runs the base branch's declaration and Hugi workflows, because both are part of the merge.
- `hugi run` gains a small, unauthenticated GitHub API client. The coordinator reads the same facts from its pull-request listing.
