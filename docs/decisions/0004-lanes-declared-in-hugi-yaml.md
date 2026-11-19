---
type: adr
title: ADR-0004 - A repository declares its lanes in hugi.yaml
description: An enrolled repository lists its macOS lanes in .github/hugi.yaml as pointers to workflow jobs. Promotion moves a lane's job into a Hugi workflow under .github/hugi/, which GitHub never runs. A lane may not have needs.
status: accepted
created: 2026-11-18
modified: 2026-11-19
---
# ADR-0004 - A repository declares its lanes in hugi.yaml

## Context

The coordinator has to learn which jobs of an enrolled repository are its macOS lanes. The repository decides what runs, and Hugi's own configuration decides only who may run, so a pull request cannot grant itself access. Enrolment and the allowlist live in Hugi's configuration. The list of lanes does not.

Promotion has to stop GitHub from running the hosted macOS job on pull requests while Hugi keeps running the lane. Three facts about GitHub and the enrolled repositories constrain how:

- GitHub runs only the workflow files directly in `.github/workflows/`. A workflow-syntax file anywhere else in the repository is never scheduled.
- A job-level `if:` cannot read the `matrix` context, so it cannot turn off one leg of a matrix job. Loom's macOS lanes are the `macos-latest` legs of `[ubuntu-latest, macos-latest]` matrices.
- Loom's macOS legs depend on a Linux job, `changes`, whose output decides whether they run. That job lists the pull request's files through the GitHub API with GitHub's token. Hugi cannot run it, because the VM holds no secret ([ADR-0002](0002-verification-only.md)).

## Decision

### The declaration

An enrolled repository lists its lanes in `.github/hugi.yaml`. Hugi reads the file at the commit whose lanes it is deciding, from the same source as the workflow files, so a pull request's lanes are the ones its own commit declares. For a pull request that commit is GitHub's merge commit ([ADR-0005](0005-pull-requests-run-on-the-merge-commit.md)); the declaration and the workflows are read at that same commit.

```yaml
lanes:
  - workflow: ci.yml
    jobs: [platform]
  - workflow: release.yml
    jobs: [build]
    matrix: { os: macos-latest }
```

The file is a YAML mapping with one key, `lanes`, a nonempty list of entries. It is read with the YAML 1.2 core schema, so `yes` and `no` are strings. YAML directives such as `%YAML 1.1`, duplicate keys, merge keys (`<<`), anchors, aliases, and explicit YAML tags are refused. Each entry is a mapping with these keys and no others:

- `workflow` (required, a string) names the file the jobs are in. A bare file name, without `/`, is read from `.github/workflows/`. A path containing `/` is relative to the repository root and must be canonical: no leading `/`, and no empty, `.`, or `..` segments. Either form must name a file directly in `.github/workflows/` or directly in `.github/hugi/`. Unlike `hugi run`, a declaration does not accept a leading `./`. Entries are compared by the path the name resolves to, so `ci.yml` and `.github/workflows/ci.yml` name the same file.
- `jobs` (required) is a nonempty list of distinct job ids in that file.
- `matrix` (optional) is a mapping from matrix key to a scalar value: a string, a number, or a boolean.

Each entry points at jobs. It never restates them. The job in its workflow file stays the lane's only definition: Hugi reads its trigger, steps, environment, `if:`, and matrix from there, as `hugi run` does.

### Lanes and their identity

A listed job without a matrix is one lane, and its entry takes no `matrix` filter. For a job with a matrix, Hugi expands the matrix as GitHub does, with `include` and `exclude` applied. Each expanded row that matches the filter is a lane. A row matches when every key of the filter is present in the row with an equal value, compared as `hugi run --matrix` compares them: by GitHub's `==`, except that a boolean also matches its written text, `true` or `false`. Keys the filter omits are free, and an entry with no filter selects every row. A filter applies to each job its entry lists.

A lane's identity is its job id with its complete expanded row: every matrix key, including keys an `include` entry adds. The workflow path is not part of it, so a lane keeps its identity when promotion moves its job to another file. The commit status for a lane is named from its identity alone. The format of that name belongs to the reporter.

### What Hugi checks when it reads the declaration

Hugi refuses the whole declaration when:

- the file does not follow the schema above: a wrong type, an unknown key, an empty list, a duplicate job id in an entry, a path that is not canonical or not in one of the two directories, or a YAML merge or duplicate key;
- a named workflow file does not exist at the commit, or the lane reader rejects it as a workflow, including when GitHub would refuse its `on:` block: its `push` and `pull_request` entries are checked whatever the event, so an unknown filter key, a pattern that does not parse, or a `branches` list of only `!` patterns refuses the declaration;
- a listed job does not exist, or declares `needs`;
- a job's matrix cannot be expanded when the file is read, for example because it is built by an expression;
- a filter key appears in no row of a job, or a filter selects no row of a job;
- a selected lane's complete row, written as `hugi run --matrix` values, does not select exactly that one row of the job's matrix, as with `version: [1, '1']` or `v: [true, 'True']`;
- a selected lane's `runs-on` does not resolve to a macOS label Hugi runs, so an entry that forgets the filter on an `[ubuntu-latest, macos-latest]` matrix is refused rather than run on Linux legs;
- two lanes have the same identity, with values compared as the filter compares them;
- two lanes would post under the same commit status name, compared ignoring case as GitHub compares status contexts. A name lists a row's values without its keys, so `{os: '1, 2'}` and `{os: '1', extra: '2'}` of one job collide, and so do jobs `build` and `BUILD` in two workflows.

A refused declaration is reported as one failure status on the commit (for a pull request, its head commit; [ADR-0005](0005-pull-requests-run-on-the-merge-commit.md)), the declaration status, whose description names the cause. It settles the commit: Hugi runs none of its lanes, and the poller treats the commit as decided. Everything the list above does not cover, such as a job's `if:`, its steps, its tools, and its timeout, belongs to the lane's run and yields that lane's verdict as `hugi run` does.

An enrolled repository whose commit has no `.github/hugi.yaml` has no lanes at that commit, and Hugi posts nothing for it.

### Events

Hugi considers commits on the enrolled repository's default branch, as `push` events, and pull requests whose author the allowlist admits, as `pull_request` events. It runs a lane for a commit only when the `on:` block of the lane's workflow would start that workflow for the event, with its `branches`, `branches-ignore`, `tags`, `tags-ignore`, `paths`, `paths-ignore`, and `types` filters evaluated as GitHub evaluates them. Path filters need the files the push or pull request changed, which Hugi reads from GitHub on the host. Hugi also honors GitHub's skip instructions: a commit whose message carries `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]`, or a `skip-checks: true` trailer starts no lane, for a push or for a pull request whose head is that commit, as GitHub starts no workflow for it. After promotion this leaves the lane's required status pending, as GitHub leaves a required hosted check pending for such a commit. The job's `if:` is then evaluated for the event. A lane that a skip instruction, the trigger, or the `if:` leaves out has no run and no status. Both decisions depend only on the commit and its event, so Hugi makes them again whenever it considers the commit.

A poller sees a pull request's state, not its activity, so the head commit of an open pull request counts as GitHub's default activity types `opened`, `synchronize`, and `reopened`. A `pull_request` entry with no `types`, or with a `types` list that includes any of those three, starts the workflow. An entry whose `types` lists none of them, such as only `labeled`, `ready_for_review`, `stacked`, or `closed`, never starts it under Hugi, so a lane triggered only by those types never runs, where GitHub would run it at that activity.

For a push to the default branch, path filters compare the commit with its first parent. GitHub compares a push with the commit the branch pointed at before it, a two-dot diff of the push's before and after. The two agree for a single commit or a merge commit. They differ when one push moves the branch by several commits, as a rebase-merge of a multi-commit pull request or any fast-forward of several commits does: an earlier commit can touch files that the first-parent diff of the last commit does not show, so Hugi could skip a path-filtered lane that GitHub would run.

A `push` entry filtered only by `tags` or `tags-ignore` never starts the workflow for a branch push, as GitHub starts it only for a tag push.

Two further divergences from GitHub are known. Hugi checks only the `push` and `pull_request` entries of `on:`, so a workflow that GitHub rejects for another event's entry still runs under Hugi. GitHub limits how many changed files a path filter considers, and Hugi does not reproduce that limit, so for a very large diff Hugi can run a lane that GitHub skips.

### No needs

A lane's job may not declare `needs`. Hugi does not run upstream jobs and does not supply their outputs. A repository whose macOS job depends on another job restructures it before declaring it as a lane.

### Promotion

Promotion is one commit in the repository and one change to its settings.

The commit moves the lane's job out of GitHub's workflow into a **Hugi workflow**: a workflow-syntax file directly under `.github/hugi/`, which GitHub never runs. The Hugi workflow carries the job under the same id, with the same expanded rows, so every lane keeps its identity. It also carries the workflow-level `env` and `defaults` the job reads, and an `on:` block, normally the original workflow's, less any path filter on pull requests (see Consequences), and it stays a complete workflow that the lane reader accepts. The same commit repoints the lane's `hugi.yaml` entry at the Hugi workflow, and makes two changes to GitHub's workflow:

- GitHub's workflow no longer produces a macOS combination of the job. For a matrix job, that means removing the macOS value from its axis and every `include` entry that resolves to a macOS runner, then checking the expanded matrix.
- Jobs in GitHub's workflow that `needs` the moved job drop it, because GitHub rejects a workflow whose `needs` names a job it does not contain. Expressions in those jobs that read the moved job's `result` or `outputs` go with it, or they would read an empty value on every run.

A job that GitHub also runs for events Hugi does not consider, such as a tag push, a schedule, or a manual dispatch, is split before promotion, so that moving the verification job leaves those events' jobs in GitHub's workflow. Tag-driven release builds stay on GitHub ([ADR-0002](0002-verification-only.md)).

The settings change makes each promoted lane's status a required check. Each lane has exactly one definition at every stage: in GitHub's workflow during shadow, and in the Hugi workflow after promotion.

The fallback for an outage reverses both. First one settings change swaps the required checks: it removes the promoted Hugi statuses and requires the hosted macOS checks in their place. The swap is needed because the hosted job reports under its own check name, so without it the merge would wait for a Hugi status that never arrives, and requiring the hosted checks keeps macOS verification a merge gate during the outage. Then the reverse commit moves the job back into GitHub's workflow. Its own pull request runs the restored hosted job, because a `pull_request` run uses the workflow the pull request brings, so it can satisfy the new requirement and merge. Ending the fallback is a promotion again. A commit on the base branch starts no run for open pull requests, so each one gets its hosted run at its next `pull_request` event, such as a push or a reopen.

## Example: Loom

Loom's `ci.yml` runs `node_matrix`, `bun_matrix`, and `docs_matrix` over `os: [ubuntu-latest, macos-latest]`. Each depends on `changes`, and the aggregator jobs `node` and `bun` depend on the matrix jobs. Before it enrols, Loom restructures its macOS legs into jobs of their own with no `needs`. The job ids below stand for those restructured jobs. The restructure also settles the macOS leg of `docs_matrix`: it becomes a declared lane like the others, or Loom drops it. A macOS leg left in GitHub's workflow keeps waiting on hosted runners after promotion.

During shadow, `.github/hugi.yaml` points at GitHub's workflow:

```yaml
lanes:
  - workflow: ci.yml
    jobs: [node_macos, bun_macos]
```

The promotion commit deletes `node_macos` and `bun_macos` from `.github/workflows/ci.yml`, removes them from the `needs` of any job that lists them, and adds `.github/hugi/ci.yml`:

```yaml
name: CI (Hugi)

on:
  push:
    branches: [main]
  pull_request:

env:
  NODE_COMPILE_CACHE: ${{ github.workspace }}/../node-compile-cache

jobs:
  node_macos:
    name: node / macos-latest
    runs-on: macos-latest
    env:
      LOOM_TEST_RUNTIME: node
      LOOM_REQUIRE_SHELLS: '1'
    steps:
      # The job's steps, moved unchanged.

  bun_macos:
    name: bun / macos-latest
    runs-on: macos-latest
    env:
      LOOM_TEST_RUNTIME: bun
      LOOM_REQUIRE_SHELLS: '1'
    steps:
      # The job's steps, moved unchanged.
```

The same commit repoints the declaration:

```yaml
lanes:
  - workflow: .github/hugi/ci.yml
    jobs: [node_macos, bun_macos]
```

If Loom kept the legs inside a matrix job without `needs` instead, the shadow entry would be `jobs: [node_matrix]` with `matrix: { os: macos-latest }`. The promotion commit would change GitHub's matrix to `os: [ubuntu-latest]` and give the Hugi workflow's copy `os: [macos-latest]`, so the lane's row, and its identity, stay `{ os: macos-latest }`.

## Considered options

- **Derive lanes from the workflow files.** Every job or matrix leg triggered by `push` or `pull_request` with a macOS `runs-on` would be a lane, with nothing to declare. But any change that stops GitHub from running the job on pull requests also hides the lane from Hugi, which evaluates the same workflow, so promotion would have to depend on a value Hugi deliberately reads differently from GitHub.
- **A reserved repository variable as the switch.** Workflows would read a variable such as `vars.HUGI_HOSTED_MACOS` in an `if:` or a matrix, and Hugi would always evaluate it as unset. Promotion and the outage fallback would need no commit. The cost is a value Hugi evaluates differently from GitHub, and a change to which jobs run that lives outside the repository's history.
- **Lane definitions inside hugi.yaml.** One Hugi file per repository, but during shadow the job would be defined twice, once for GitHub and once for Hugi, and the two could drift while shadow is meant to show they match.
- **A lane list in Hugi's configuration.** It contradicts the rule that the repository says what to run, and makes every lane change a change to Hugi's host.
- **Fixed upstream outputs in hugi.yaml.** A lane entry would pin `needs` outputs, as `hugi run --needs` does. Hugi would then run legs that GitHub skips for the same commit, so the two would not compare like with like during shadow.
- **Read upstream outputs from GitHub's run.** GitHub does not expose job outputs through its API, and waiting for GitHub's job is waiting on GitHub's scheduling, which [ADR-0001](0001-github-never-schedules.md) rules out.
- **Ignore `on:` and run every lane on every commit.** It is simpler for the poller, but Hugi would run lanes GitHub never runs for the same commit. Mimir's `release.yml`, for example, has no `push` trigger for `main` and filters pull requests by path.

## Consequences

- This replaces the consequence in [ADR-0001](0001-github-never-schedules.md) that the hosted macOS job stays in the workflow behind a switch. After promotion the job is not in GitHub's workflow, and the fallback for an outage is a commit plus a settings change.
- A promoted lane must not be left out on pull requests by its `if:` or by a path filter in its `on:` block. A required status that is never posted blocks the merge.
- A pull request that deletes `hugi.yaml` or drops a lane posts no status for it. After promotion that blocks the merge, because the required status never arrives.
- The poller reads `.github/hugi.yaml` and evaluates trigger filters at every commit it considers, and reads changed files from GitHub for path filters.
- The declaration reader expands a filter into complete rows. `hugi run` needs no change: it already takes a complete row with `--matrix`, and the path form of `<workflow>:<job>` already reaches a Hugi workflow.
- Loom restructures its macOS legs before it enrols. Norn's `platform` job and Mimir's `release.yml` `build` job have no `needs` and can be declared for shadow as they are. Mimir's `build` job also produces release assets on tag pushes, and its workflow filters pull requests by path, so Mimir splits it before promotion: the tag-driven release build stays in GitHub's workflow, and the verification job it promotes has no path filter on pull requests.
