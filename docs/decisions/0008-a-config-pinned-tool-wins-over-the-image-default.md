---
type: adr
title: ADR-0008 - A tool the mise config pins wins over the image's default
description: Under tools mise, the later steps take each variable from the config's tool environment, except a variable that a workflow tool sets, which keeps the first tool environment's value. An environment of the workflow tools alone, computed with every mise config kept out, names those variables. A Rust version the config pins then sets RUSTUP_TOOLCHAIN instead of the image's.
status: accepted
created: 2026-11-25
modified: 2026-11-25
---
# ADR-0008 - A tool the mise config pins wins over the image's default

This record amends [ADR-0006](0006-a-lane-chooses-where-its-tools-come-from.md) in two places and [ADR-0007](0007-a-workflow-installs-tools-from-its-mise-config.md) in one. It changes nothing else that either decides:

- ADR-0006's "How a step finds its tools" computes the tool environment with one `mise env --json`. For a `tools: mise` lane, the same step now also writes the workflow tools' bin directories and an environment of the workflow tools alone, which step 4 of `tools: mise` used to compute after `mise install`.
- In step 4 of ADR-0006's `tools: mise`, the first tool environment's variables win over the config environment's. This record lets the config environment's variables win, except those that a workflow tool sets. It also narrows the guarantee that ends the step: nothing in the config can move a workflow tool's place on `PATH` or the variables it sets.
- ADR-0007 accepts as a limit that, under `tools: mise`, an image default's variable such as `RUSTUP_TOOLCHAIN` can override a tool the config pins. That limit no longer holds.

## Context

ADR-0006 computes the first tool environment outside the workspace, so it holds the workflow tools and the image's default tools. A `tools: mise` lane's later steps take their `PATH` from the workflow tools' bin directories, then the config's tool environment, then the first one. Their other variables came from the first environment wherever both environments set one.

Some tools are chosen by a variable as well as by `PATH`. Rust is one: `rustup`'s proxies run the toolchain that `RUSTUP_TOOLCHAIN` names, wherever they sit on `PATH`. The golden image's global config pins a Rust version, so the first environment always sets `RUSTUP_TOOLCHAIN`. With no workflow pin for Rust and a different Rust version in the repository's mise config, the image's `RUSTUP_TOOLCHAIN` replaced the config's, and the steps ran the image's Rust. ADR-0006 promises that a tool the config pins runs ahead of the image's default; for Rust, it did not.

The workflow tools' variables have to keep winning. The config environment is computed with the workflow tools' per-tool version variables set, so it usually carries the same values, but a tool alias or `disable_tools` in the config can change or drop them.

## Decision

For a `tools: mise` lane, the "Tool environment" step computes two more things after the first tool environment, from the same environment and before the checkout: the workflow tools' bin directories (`mise bin-paths`, in the same directory as the first), and an environment of the workflow tools alone. That environment is `mise env --json` run with the workflow tools' per-tool version variables and `MISE_NO_ENV=1`, and with every mise config kept from loading, by the isolation that ADR-0007 gives a `jdx/mise-action` step's own commands: an empty `MISE_CONFIG_DIR`, a `MISE_GLOBAL_CONFIG_FILE` inside it, and `MISE_CEILING_PATHS` above the workspace. It runs in that empty config directory, which is Hugi's own, under the ceiling and outside the workspace. With no config, mise sets only the variables of the tools that the version variables name, so this environment's variables, other than `PATH`, are the ones the workflow tools set. Only their names are used; the values come from the other two environments. A failure in either fails the "Tool environment" step, as a failure of `mise env --json` does.

Both are computed before any file of the repository reaches the guest, and from the same inputs as the first tool environment, the plan's `env` not among them. So a `[plugins]` entry in the config named after a workflow tool, which `mise install` would put in mise's data directory in place of that tool, cannot change them, and a variable in the plan's `env` cannot make a tool the workflow tools'.

In step 4, the later steps' `PATH` keeps the order ADR-0006 gives it. Every other variable comes from the config's tool environment, then from the first tool environment when the config's does not set it. A variable that the environment of the workflow tools alone sets keeps the first tool environment's value, whatever the config's sets. When the first does not set it, there is no value to keep, and the config's stands.

So a tool that the config pins and the workflow does not sets its variables, such as `RUSTUP_TOOLCHAIN` for Rust, in place of the image default's. Nothing in the config can move a workflow tool's place on `PATH` or the variables it sets, not a tool alias, `disable_tools`, or `[env]`.

A tool that the config pins can set a variable that no workflow tool sets, such as `RUSTC_WRAPPER` or `NODE_OPTIONS` from a plugin's environment, and then the steps run with it. That can change how a workflow tool behaves. It held under ADR-0006 too, and it is accepted: the config is the source that the lane declared.

## Considered options

- **Ask mise which tool sets each variable** with `mise env --json-extended` beside the first tool environment. It names the tool behind each variable directly, but it adds a second output format of mise for Hugi to read, and a flag for the image build to check. The isolated environment reuses the isolation and the output Hugi already depends on.
- **Keep a table of the variables each tool sets in Hugi.** It needs no extra mise call, but it goes stale whenever mise or a plugin adds a variable, and a tool missing from it falls back to the old rule.
- **Let the config environment win outright.** A tool alias or `disable_tools` in the config could then move a workflow tool's variables, which ADR-0006 rules out.
