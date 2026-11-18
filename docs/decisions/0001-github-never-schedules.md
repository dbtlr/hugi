---
type: adr
title: ADR-0001 - GitHub never schedules
description: Hugi is a standalone coordinator that decides when lanes run. GitHub only supplies commits and receives verdicts as commit statuses; no run waits on a GitHub runner.
status: accepted
created: 2026-11-18
modified: 2026-11-18
---
# ADR-0001 - GitHub never schedules

## Context

GitHub's hosted macOS runners queue for minutes and sometimes never arrive. In one measurement, an original run and four reruns of one commit's workflow on GitHub produced three macOS jobs that waited 15 to 25 minutes, never received a runner, and were cancelled, so two of the five failed with no code cause. The failure is GitHub's scheduling, not only its machines.

## Decision

Hugi is a standalone coordinator. It reads commits from GitHub, decides itself which lanes run and when, runs them on its own host, and posts each verdict back as a commit status. GitHub has two roles: a source of commits and a place to show verdicts. Hugi does not register as an Actions runner and never waits for GitHub to assign work.

Hugi learns about commits by polling, not by webhooks. The host should expose no public endpoint, and a reconciliation poll is needed in any design to recover missed deliveries. Hugi derives its queue from the commits that lack a verdict, so a restart or an outage heals itself.

## Considered options

- **A self-hosted runner attached to GitHub Actions.** It needs no new program, but every job still waits for GitHub to schedule it, which is the failure being removed.
- **Webhooks through a tunnel.** Faster by up to a minute, but it exposes an endpoint on the host and still needs the reconciliation poll.

## Consequences

The workflow file stays the only definition of a lane: Hugi reads the job's steps from it instead of restating them. The hosted macOS job can stay in the workflow behind a switch, as a fallback for when the host is down. [ADR-0004](0004-lanes-declared-in-hugi-yaml.md) replaces this fallback: promotion moves the job out of GitHub's workflow, and the fallback for an outage is removing Hugi's statuses from the required checks, then a commit that moves the job back.
