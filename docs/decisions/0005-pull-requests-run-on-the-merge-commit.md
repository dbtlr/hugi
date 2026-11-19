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

A lane's verdict must match GitHub's. For a `pull_request` event, GitHub does not run the pull request's head commit. It runs a merge of the head into the base branch, which it computes in the background and keeps at `refs/pull/<n>/merge`, and `actions/checkout` checks out that commit by default. The merge commit's first parent is the base branch's tip when GitHub computed it, and its second parent is the head. GitHub runs no `pull_request` workflow while the pull request has a merge conflict.

Both `refs/pull/<n>/head` and `refs/pull/<n>/merge` can be fetched anonymously over https from a public repository, including for a pull request from a fork. The merge ref is not trustworthy on its own: GitHub leaves the last merge it computed in place after the pull request gains a conflict or is closed, so a stale merge ref can name the current head as its second parent. GitHub's API is the authority. Reading a single pull request returns its `state`, its `head.sha`, `head.ref`, and `base.ref`, its `mergeable` flag (`null` while GitHub computes it, `false` on a conflict), and its `merge_commit_sha`, which is `null` when there is no current merge; that read also starts the computation when it is stale. Neither ref records the head or base branch's name.

The runner's view of a `pull_request` job:

- `GITHUB_SHA` is the merge commit, `GITHUB_REF` is `refs/pull/<n>/merge`, `GITHUB_REF_NAME` is `<n>/merge`, and `GITHUB_REF_TYPE` is `branch`.
- `GITHUB_HEAD_REF` and `GITHUB_BASE_REF` are the names of the head and base branches. The `github.head_ref` and `github.base_ref` contexts hold the same values. For other events they are empty.

Branch protection counts a required status on the pull request's head commit.

[ADR-0004](0004-lanes-declared-in-hugi-yaml.md) reads the lane declaration and the workflow files at the commit that stands for a pull request, and left open which commit that is.

## Decision

### The commit

A pull-request run checks out GitHub's merge commit. When the run starts, Hugi reads the pull request from GitHub's single-pull-request endpoint and, on the host, fetches `refs/pull/<n>/head` and `refs/pull/<n>/merge` from the base repository. It uses the merge commit only when all of these hold:

1. the pull request's `state` is `open`;
2. its `mergeable` is `true`, and its `merge_commit_sha` is not `null`;
3. `refs/pull/<n>/merge` is that `merge_commit_sha`;
4. `refs/pull/<n>/head` is the pull request's `head.sha`;
5. the merge commit has exactly two parents, and its second parent is `head.sha`.

Otherwise the pull request has no current merge and does not run. Hugi names the first condition that failed: the pull request is closed (1); it has a merge conflict (2, with `mergeable` `false`); GitHub has not computed the merge for its head yet (2 with `mergeable` `null` or `merge_commit_sha` `null`, 3, or 5); or the pull request moved while Hugi read it (4). The coordinator considers the pull request again at its next poll. `hugi run` exits with no verdict, as it does for a commit it cannot fetch.

The merge is resolved when the run starts, not when the pull request is queued, so a queued run never checks out a merge its head has left behind. If the VM later cannot fetch the merge commit, the run has no verdict, and the coordinator resolves the merge again before it retries.

The lane declaration and the workflow files are read at the merge commit, and the VM checks it out. A draft pull request runs like any other, as on GitHub.

The coordinator's queue holds candidates, a pull request's head commit with a lane, found by reading the declaration and triggers at the merge current when it polled. The poller resolves that merge under the same five conditions, through the single-pull-request read, since a pull-request listing lacks `mergeable`; a pull request with no current merge yields no candidates until a later poll. When a run starts, Hugi reads the declaration, the lane's trigger, and its `if:` again at the merge it resolved, and those decide. A lane that merge no longer selects is dropped with no status, and a declaration that merge refuses posts the declaration status.

### Where the outcome belongs

Every status Hugi posts for a pull request goes on its head commit, where branch protection reads it: each lane's verdict, and the declaration status when the declaration at the merge commit is refused. The head commit is also what the coordinator reconciles. A lane whose status on the head commit carries a verdict does not run again; a `pending` status settles nothing. A lane with no status there runs at the merge commit current when the run starts. A refused declaration's status on the head commit settles every lane of that head that has no verdict yet; verdicts already on the head stand, and so does the declaration status when a later merge on the same head declares lanes that Hugi accepts. The same holds when the refusal comes from a newer merge after the base branch moved: the declaration status is posted, and lanes without a verdict do not run.

### The values the run sees

For a pull-request run, the `github.*` contexts and the runner's environment for every step hold the values below. As for every runner variable, a workflow, job, or step `env:` that sets one of these names, or a `GITHUB_ENV` write, takes precedence in the steps it covers; this decision does not change that layering, so in such a step the variable can differ from its `github.*` context:

| Variable | Context | Value |
| --- | --- | --- |
| `GITHUB_EVENT_NAME` | `github.event_name` | `pull_request` |
| `GITHUB_SHA` | `github.sha` | the merge commit |
| `GITHUB_REF` | `github.ref` | `refs/pull/<n>/merge` |
| `GITHUB_REF_NAME` | `github.ref_name` | `<n>/merge` |
| `GITHUB_REF_TYPE` | `github.ref_type` | `branch` |
| `GITHUB_HEAD_REF` | `github.head_ref` | the head branch's name, the API's `head.ref` (without the fork owner) |
| `GITHUB_BASE_REF` | `github.base_ref` | the base branch's name, the API's `base.ref` |

For a `push` run, `GITHUB_HEAD_REF`, `GITHUB_BASE_REF`, `github.head_ref`, and `github.base_ref` are empty strings, and the other values stay as they are. The event payload, `github.event.*` and `GITHUB_EVENT_PATH`, is still not supplied: a lane that reads it fails as before.

The event contract carries these facts. A `pull_request` event holds the pull request's number, head commit, head branch, and base branch, and its `sha` is the merge commit. A `push` event holds the ref type and name, as before.

### Running a pull request by hand

`hugi run <owner/name> pull/<n> <lane>` runs a lane for pull request `<n>`. Hugi reads the pull request with one unauthenticated call to GitHub's API, then resolves the merge commit as the coordinator does. A pull request that does not exist, an API call that fails or is rate-limited, and a pull request with no current merge all exit with no verdict (exit code 3), as an unknown commit does. `<n>` is a positive decimal number, and for an `owner/name` repository `pull/<n>` always names the pull request, never a branch of that name; such a branch runs by its sha with `--ref-name`. A local repository has no pull requests and refuses `pull/<n>` with the same advice. `--event pull_request` without `pull/<n>`, `--event push` with it, and `--ref-type` or `--ref-name` with it are usage errors, because none of them can describe a faithful pull-request run.

## Considered options

- **Run the head commit.** It needs no merge and no wait after a push, but the run is not the commit GitHub tests. The declaration and the workflows come from the branch alone, so a branch older than a promotion reads the old workflow and declaration and posts no status for a promoted lane.
- **Compute the merge on the host.** Hugi would need the blobs and a merge on the host, over pull-request content, and its merge could differ from GitHub's on edge cases such as conflicts. It gains nothing over the merge GitHub already keeps.
- **Name a pull-request run with flags.** `--pr`, `--head-ref`, and `--base-ref` beside the merge commit's sha would need no API call and would work on a local repository. Nothing would check that the commit belongs to the pull request, and a person would have to look up the merge commit and both branches by hand.

## Consequences

- A pull-request run waits until GitHub has computed the merge for the latest push. The wait is usually seconds; the coordinator absorbs it by polling again.
- A conflicting or closed pull request has no run and no status, as on GitHub. After promotion a conflicting pull request's required status stays pending until the conflict is resolved, as a hosted check does.
- The merge commit's base is the base branch's tip when GitHub last computed the merge, which can be newer than the tip when GitHub ran its own workflow. A lane runs once per head commit: a base branch that moves while the head stays put starts no new run of a lane that has a verdict, as on GitHub. A lane the base branch newly declares does run, against the newer merge, where GitHub would wait for the pull request's next event.
- A declaration refused because of the base branch's `hugi.yaml` stays on every open pull request's head after the base is fixed, until each pull request gets a new head commit. After promotion that blocks those pull requests' merges, as a hosted check that failed on a broken base branch stays failed until the pull request is pushed again or the check is re-run. Hugi has no re-run, and closing and reopening the pull request does not clear the status, so a new head commit is the remedy.
- In shadow, Hugi's verdict and the hosted result for the same head commit can come from merges with different bases. A mismatch whose two merge commits differ is not evidence against Hugi until the hosted run's merge is compared; the shadow report records the merge commit each side tested.
- A lane's verdict on a commit settles that lane for the commit, whichever event produced it. Two pull requests with the same head commit, or a pull request whose head is also a default-branch commit, share one status per lane, and the second is treated as decided. GitHub would run each event. This is a known gap: it needs a pull request opened from a commit that already has a verdict, which the enrolled repositories' branch workflow does not produce.
- A branch that predates a repository's enrolment or promotion still runs the base branch's declaration and Hugi workflows, because both are part of the merge.
- `hugi run` gains a small, unauthenticated GitHub API client, subject to GitHub's anonymous rate limit of 60 requests an hour. The coordinator reads the same pull-request fields through its own credential.
