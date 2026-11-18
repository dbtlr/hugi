---
type: adr
title: ADR-0002 - Verification only, with no secrets in the VM
description: Hugi runs verification lanes only. The VM holds no secret and publishes nothing, so the worst a pull request can do is waste a run.
status: accepted
created: 2026-11-18
modified: 2026-11-18
---
# ADR-0002 - Verification only, with no secrets in the VM

## Context

Hugi runs code from pull requests, including code that has not been reviewed. Who may run is limited by an allowlist kept outside the repositories, but an allowlisted author's change can still contain mistakes or a compromised dependency. Release builds need credentials to sign and publish.

## Decision

Hugi runs verification lanes only: builds and tests whose only output is a verdict and its logs. The VM holds no secret: no GitHub token, no signing key, and no registry credential. It publishes nothing. Source is delivered to the VM without placing a credential in it. Hugi's own GitHub permission is limited to reading repositories and posting commit statuses, and that credential stays on the host, outside the VM.

Tag-driven release builds and any job that needs a secret stay on GitHub. A lane step that needs a secret cannot run under Hugi and is not supported.

## Considered options

- **Inject secrets into the VM for release builds.** It would let Hugi replace the hosted release jobs too, but a secret in a VM that runs pull-request code is a secret that code can read.
- **Scoped, short-lived tokens in the VM.** A token limited to one repository and one hour still lets a pull request act as Hugi for that hour. Verification lanes need no token at all.

## Consequences

A lane that depends on a secret has to be split, with its secret-free verification part enrolled. The VM still has outbound network access. Limiting it is a separate decision.
