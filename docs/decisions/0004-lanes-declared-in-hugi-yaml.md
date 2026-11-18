---
type: adr
title: ADR-0004 - A repository declares its lanes in hugi.yaml
description: An enrolled repository lists its macOS lanes in .github/hugi.yaml as pointers to workflow jobs. Promotion moves a lane's job into a Hugi workflow under .github/hugi/, which GitHub never runs. A lane may not have needs.
status: accepted
created: 2026-11-18
modified: 2026-11-18
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

An enrolled repository lists its lanes in `.github/hugi.yaml`. Hugi reads the file at the commit under test, from the same source as the workflow files, so a pull request's lanes are the ones its own commit declares.

```yaml
lanes:
  - workflow: ci.yml
    jobs: [platform]
  - workflow: release.yml
    jobs: [build]
    matrix: { os: macos-latest }
```

Each entry points at jobs. It never restates them:

- `workflow` names the file the jobs are in. A bare file name is read from `.github/workflows/`, and a path containing `/` is relative to the repository root, the same rule as `hugi run`.
- `jobs` lists job ids in that file.
- `matrix` is optional. Each combination of a listed job's matrix whose values match every key given is a lane, so a filter can select several combinations. A key the filter omits is free. An entry for a job with no matrix takes no filter.

The job in its workflow file stays the lane's only definition. Hugi reads its steps, environment, `if:`, and matrix from there, as `hugi run` does.

### What is invalid

Hugi refuses the whole declaration, and reports the refusal on the commit as a failure, never as a commit with no lanes, when:

- the file is not valid YAML, or has a key this record does not define;
- a named workflow file or job does not exist at the commit;
- a `matrix` filter selects no combination of a job, or names a key the job's matrix lacks;
- a listed job declares `needs`;
- two entries select the same lane.

An enrolled repository whose commit has no `.github/hugi.yaml` has no lanes at that commit, and Hugi posts nothing for it.

### Events

Hugi ignores a workflow's `on:` block. It runs every declared lane for commits on the enrolled repository's default branch and for pull requests whose author the allowlist admits, with the event context of that commit. The job's `if:` is still evaluated for that event. A lane whose `if:` skips it for the event has no run and no status.

### No needs

A lane's job may not declare `needs`. Hugi does not run upstream jobs and does not supply their outputs. A repository whose macOS job depends on another job restructures it before declaring it as a lane.

### Promotion

Promotion is one commit in the repository. It moves the lane's job out of GitHub's workflow into a **Hugi workflow**: a workflow-syntax file under `.github/hugi/`, which GitHub never runs. The same commit repoints the lane's `hugi.yaml` entry at the new file. The Hugi workflow carries the job together with the workflow-level `env` and `defaults` the job reads. It stays a complete workflow that GitHub would accept, `on:` included, because the lane reader checks the whole file as it does for any workflow. Hugi ignores the `on:` block, so `on: workflow_dispatch` serves.

For a matrix job, the commit removes the macOS value from the GitHub workflow's matrix and gives the Hugi workflow's copy of the job only that value. Each lane has exactly one definition at every stage: in GitHub's workflow during shadow, and in the Hugi workflow after promotion.

The fallback for an outage is the reverse commit, which moves the job back into GitHub's workflow. A pull request runs on GitHub after its merge commit includes that change.

## Example: Loom

Loom's `ci.yml` runs `node_matrix`, `bun_matrix`, and `docs_matrix` over `os: [ubuntu-latest, macos-latest]`, and each depends on `changes`. Loom first restructures its macOS legs so that they have no `needs`, for example by moving the macOS legs into jobs of their own that always run. The job ids below stand for those restructured jobs.

During shadow, `.github/hugi.yaml` points at GitHub's workflow:

```yaml
lanes:
  - workflow: ci.yml
    jobs: [node_macos, bun_macos]
```

The promotion commit deletes `node_macos` and `bun_macos` from `.github/workflows/ci.yml` and adds `.github/hugi/ci.yml`:

```yaml
name: CI (Hugi)

on: workflow_dispatch

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

If Loom kept the legs inside a matrix job instead, the shadow entry would be `jobs: [node_matrix]` with `matrix: { os: macos-latest }`. The promotion commit would change GitHub's matrix to `os: [ubuntu-latest]` and give the Hugi workflow's copy `os: [macos-latest]`.

## Considered options

- **Derive lanes from the workflow files.** Every job or matrix leg triggered by `push` or `pull_request` with a macOS `runs-on` would be a lane, with nothing to declare. But any change that stops GitHub from running the job on pull requests also hides the lane from Hugi, which evaluates the same workflow, so promotion would have to depend on a value Hugi deliberately reads differently from GitHub.
- **A reserved repository variable as the switch.** Workflows would read a variable such as `vars.HUGI_HOSTED_MACOS` in an `if:` or a matrix, and Hugi would always evaluate it as unset. Promotion and the outage fallback would need no commit. The cost is a value Hugi evaluates differently from GitHub, and a change to which jobs run that lives outside the repository's history.
- **Lane definitions inside hugi.yaml.** One Hugi file per repository, but during shadow the job would be defined twice, once for GitHub and once for Hugi, and the two could drift while shadow is meant to show they match.
- **A lane list in Hugi's configuration.** It contradicts the rule that the repository says what to run, and makes every lane change a change to Hugi's host.
- **Fixed upstream outputs in hugi.yaml.** A lane entry would pin `needs` outputs, as `hugi run --needs` does. Hugi would then run legs that GitHub skips for the same commit, so the two would not compare like with like during shadow.
- **Read upstream outputs from GitHub's run.** GitHub does not expose job outputs through its API, and waiting for GitHub's job is waiting on GitHub's scheduling, which [ADR-0001](0001-github-never-schedules.md) rules out.

## Consequences

- This replaces the consequence in [ADR-0001](0001-github-never-schedules.md) that the hosted macOS job stays in the workflow behind a switch. After promotion the job is not in GitHub's workflow, and the fallback for an outage is a commit.
- A lane's commit status must keep its name across promotion, so the reporter names it from the job id and matrix values, never from the workflow path.
- A promoted lane must not be skipped by its `if:` on pull requests. A required status that is never posted blocks the merge.
- A pull request that deletes `hugi.yaml` or drops a lane posts no status for it. After promotion that blocks the merge, because the required status never arrives.
- The poller reads `.github/hugi.yaml` at every commit it considers. `hugi run` needs no change: the path form of `<workflow>:<job>` already reaches a Hugi workflow.
- Loom restructures its macOS legs before it enrols. Norn's `platform` job and Mimir's `release.yml` `build` job have no `needs` and can be declared as they are.
