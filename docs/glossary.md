---
title: Glossary
description: Hugi's domain language for lanes, runs, verdicts, images, and how a repository comes to trust its verdicts. Use these terms in code, docs, and reviews.
---
# Hugi Glossary

Hugi runs a repository's macOS CI lanes in throwaway VMs on its own host and reports each verdict to GitHub. These terms name what it runs, what it produces, and how a repository comes to rely on it.

## Running

**Lane**:
One job, with its matrix values fixed, that a repository's lane declaration names for Hugi to run on macOS. The job's workflow file, GitHub's or a Hugi workflow, is the lane's only definition.
_Avoid_: Job (when Hugi's unit is meant), pipeline, check

**Step plan**:
The ordered steps of a lane, read from the workflow file at a commit.
_Avoid_: Script, recipe

**Run**:
One execution of a lane at a commit, in its own VM.
_Avoid_: Build, attempt

**Verdict**:
The pass or fail Hugi reports for a lane at a commit, with its logs. A lane that cannot be read, a lane whose tools cannot be resolved, a failing step, and a timeout are all fail verdicts. A run that Hugi interrupts, that fails to clone or boot its VM, that loses its VM mid-run, or that cannot fetch or read the source yields no verdict, because the failure lies outside the lane's steps. A lane selection that picks nothing to run, such as a missing job or a job whose `if:` is false for the event, is a usage error and yields no verdict either. In the coordinator, a missing job refuses the lane declaration, and a job whose trigger or `if:` leaves it out for the event has no run and no status.
_Avoid_: Result, status (except for the GitHub commit status that carries a verdict)

**Hosted result**:
The outcome of the same lane at the same commit on GitHub's hosted runners, which shadow compares verdicts against.
_Avoid_: Hosted verdict

**Hugi workflow**:
A workflow-syntax file under `.github/hugi/` that holds a repository's promoted lanes. GitHub never runs it. Hugi reads it like any workflow, `on:` block included.
_Avoid_: Shadow workflow, private workflow

**Golden image**:
The VM image every run is cloned from, holding the toolchains and warm package caches the enrolled lanes need.
_Avoid_: Base image, template, snapshot

## Admission

**Enrolment**:
The admission of a repository to Hugi, recorded outside the repository.
_Avoid_: Registration, onboarding, subscription

**Lane declaration**:
The repository's `.github/hugi.yaml`, read at the commit under test, which points at the workflow jobs and matrix values that are its lanes. A declaration Hugi refuses is reported as one failure status on the commit, which is that commit's verdict.
_Avoid_: Lane list, manifest, hugi config

**Allowlist**:
The authors, recorded outside the repositories, whose pull requests Hugi runs. Commits on an enrolled repository's default branch run without it.
_Avoid_: Whitelist, trusted users

## Authority

**Shadow**:
The period in which an enrolled repository's verdicts are posted as advisory statuses and compared with the hosted results, while nothing depends on them.
_Avoid_: Dry run, trial, beta

**Promotion**:
The change that makes a repository's verdict a required check and moves its lanes' jobs out of GitHub's workflow into a Hugi workflow, so GitHub no longer runs them, after the verdicts matched through shadow.
_Avoid_: Graduation, cutover
