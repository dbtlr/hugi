---
type: adr
title: ADR-0007 - A workflow installs tools from its mise config with jdx/mise-action
description: Hugi runs a jdx/mise-action v5 step at its own place in the job, doing what the action does on GitHub's runner, after checking the repository's mise config against the workflow tools, and fails the step when a tool could resolve differently than on GitHub. The action needs no tools key, and a lane that sets tools mise and uses the action fails.
status: accepted
created: 2026-11-24
modified: 2026-11-24
---
# ADR-0007 - A workflow installs tools from its mise config with jdx/mise-action

This record amends [ADR-0006](0006-a-lane-chooses-where-its-tools-come-from.md) in five places. It changes nothing else that ADR-0006 decides:

- ADR-0006 keeps `jdx/mise-action` an unsupported action under both values of `tools`. This record supports it under `tools: workflow` and refuses it under `tools: mise`.
- Under `tools: workflow`, ADR-0006 makes the tool environment the lane's only source of tools. A lane whose job runs `jdx/mise-action` also takes tools from the repository's mise config, from that step on.
- ADR-0006 runs every step with `MISE_IGNORED_CONFIG_PATHS` set to the workspace. Steps after a `jdx/mise-action` step that ran run without it, as on GitHub's runner.
- ADR-0006 runs every step without `MISE_TRUSTED_CONFIG_PATHS`. A `jdx/mise-action` step writes it to `GITHUB_ENV` for later steps, as the action does.
- ADR-0006 says a step never finds its tools through mise's shims. A step after a `jdx/mise-action` step can, when the action puts the shims directory on `PATH`, as it does on GitHub's runner.

## Context

[ADR-0006](0006-a-lane-chooses-where-its-tools-come-from.md) gives a repository two sources of tools: its workflow's setup actions, and, with `tools: mise`, its mise config. A lane with `tools: mise` installs from the config under Hugi only. GitHub's runner has no mise, so the hosted job takes those tools from somewhere else, often a script. Loom's jobs install Nushell with a local composite action, a bash script that downloads a release and checks its SHA-256 sum. Hugi refuses local actions, so those lanes cannot run.

[`jdx/mise-action`](https://github.com/jdx/mise-action) installs mise on GitHub's runner and installs the tools that the repository's mise config requests. With it, the workflow itself declares "install the tools that `mise.toml` pins", and GitHub's runner and Hugi read the same file. Hugi can recognise the step by its action reference. A `run:` step that installs mise looks like any other command.

On GitHub's runner, the action does more than `mise install`. With its v5.3.0 defaults:

- it runs `mise install --locked` when it finds a mise lock file, so the lock file pins what installs;
- it exports what `mise env` prints to later steps: the config's `[env]` table, the tools' variables, and the `PATH` entries mise manages, `_.path` included;
- it puts mise's shims directory on `PATH` for later steps, and exports `MISE_TRUSTED_CONFIG_PATHS`, `MISE_YES`, and `MISE_LOG_LEVEL`;
- it succeeds with no config, installing nothing, and before the checkout.

ADR-0006's "Install tools from mise config" step does none of these. It turns the lock file off, leaves out `[env]`, keeps the shims off `PATH`, and fails when there is no config. A lane whose workflow uses the action would get a different verdict from Hugi than from GitHub if Hugi ran that step in the action's place.

Earlier major versions of the action behave differently: v2 exports no `mise env` and never adds `--locked`, and v3 writes the whole of `mise env`, `PATH` included, to `GITHUB_ENV`.

## Decision

### Which references run

Hugi runs `jdx/mise-action` at a reference that names major version 5: the tag `v5`, a tag `v5.<minor>` or `v5.<minor>.<patch>`, or a 40-character commit SHA. It reproduces v5.3.0. Any other reference, such as `v4` or `main`, fails resolution. Hugi cannot tell which version a SHA names, so a SHA pin counts as v5; that is a limit below.

### Hugi does what the action does

Hugi runs a `jdx/mise-action` step at its own place in the job, as one of the job's steps. Its `if:`, `timeout-minutes`, and `env` apply as to any step, and so does `continue-on-error`, except for the failures marked *Hugi's own* below. A step that its `if:` skips changes nothing.

The step does, in the guest, what the action does on GitHub's runner, in the action's order, for the inputs that the [supported actions](../supported-actions.md#jdxmise-action) list accepts. Each variable the step writes to `GITHUB_ENV` is also set for the step's own remaining commands, as the action's `core.exportVariable` sets it for its own process:

1. When `mise_env` is set, it writes `MISE_ENV`.
2. When `version` is set, it checks that the guest's mise reports that version. A mismatch fails the step, naming both versions, and is Hugi's own. Without `version`, the step uses the guest's mise.
3. It writes `MISE_EXPERIMENTAL=1` when `experimental` is true, `MISE_LOG_LEVEL` from `log_level` (`info` by default), `MISE_TRUSTED_CONFIG_PATHS` set to the workspace, and `MISE_YES=1`. As in the action, each of these is written only when the step's environment leaves it unset or empty.
4. When `add_shims_to_path` is true, the default, it adds the shims directory to `GITHUB_PATH`, and then the workflow tools' bin directories. The shims directory is the action's: `shims` under `MISE_DATA_DIR`, else under `$XDG_DATA_HOME/mise`, else under `~/.local/share/mise`. The workflow tools' directories come after it so that they stay ahead of it on `PATH`. On GitHub's runner no shim exists for a tool that only a setup action installed.
5. When `reshim` is true, it runs `mise reshim -f`.
6. It runs `mise --version`.
7. It checks the repository's config against the workflow tools, as described below.
8. When `install` is true, the default, it runs `mise install` in the working directory, followed by the tool names from `install_args`. It adds `--locked` when a mise lock file lies in the working directory or one of its ancestors up to the workspace root, matched by the names and places that the action searches. Directories above the workspace count as empty, as they are on GitHub's runner. When `monorepo` is true and the config sets `monorepo.config_roots`, the step fails, because Hugi does not reproduce a monorepo install. That failure is Hugi's own.
9. It runs `mise ls`, as the action does.
10. When `env` is true, the default, it runs `mise env --json` in the working directory and writes every variable except `PATH` to `GITHUB_ENV`. When `export_path` is also true, the default, it first runs the overlap check described below, then adds the entries that `mise env --paths` lists to `GITHUB_PATH`, in the order that keeps mise's first entry first. The step's log names the variables it exported but not their values.

The working directory is `working_directory` when set, a directory inside the workspace, and the workspace otherwise. A job's `defaults.run.working-directory` does not apply, because it applies only to `run:` steps. A working directory that does not exist fails the step, as it fails the action.

The step writes its `GITHUB_ENV` and `GITHUB_PATH` additions as it goes. A failure partway through keeps the additions made before it, as on GitHub's runner, for any later step that still runs.

The image's mise must support `mise env --paths`, `mise install --locked`, and `mise env --json`. The step fails when it does not, and does not reproduce the action's fallbacks for older releases. The action also adds the directory of its own mise binary to `PATH`. Hugi does not, because the guest's mise is already on the base `PATH`, and putting its directory first would put the other programs installed beside it ahead of the tool environment.

### What mise sees in the step

GitHub's runner starts with a fresh mise and no config outside the repository. The guest's mise has the image's global config, which pins the image's default tools, and the guest's workspace lies under the home directory that holds it. So the step's own mise commands run with `MISE_CEILING_PATHS` set to the workspace's parent directory, which stops mise's search for config files at the workspace, and with `MISE_CONFIG_DIR` and `MISE_GLOBAL_CONFIG_FILE` pointing at an empty directory of Hugi's. Before the check, the step lists the config files that mise loads in the working directory. When any of them lies outside the workspace after resolving symbolic links, the step fails, naming the file, and that failure is Hugi's own. The image's installed tools stay installed, and mise reuses one when the config requests its version.

The step's own mise commands run with the step's environment, with two of Hugi's runner variables removed: `MISE_IGNORED_CONFIG_PATHS`, and the workflow tools' per-tool version variables, such as `MISE_NODE_VERSION`. GitHub's runner sets neither. A value that the workflow, job, or step `env`, or an earlier step's `GITHUB_ENV`, gives one of these variables stays, as it stays on GitHub's runner.

### The check against the workflow tools

Before it installs, the step reads the version that the repository's config requests for each tool, in the working directory and with the step's environment. It compares each workflow tool with the config's request for it by the rules of ADR-0006's "Install tools from mise config" step: only entries whose source is a config file inside the workspace count, and versions compare as written. A workflow tool that the config requests at a different version, or at several versions, fails the step. The failure names the tool, both versions, and the file that pins the config's version, and it is Hugi's own.

### The overlap check

Hugi installs the workflow tools before the job's first step, while GitHub's runner installs each at its setup action's step. On `PATH`, the action's additions come before the workflow tools in every later step under Hugi. On GitHub, a setup action that runs after the action comes before it. So the order of the two on `PATH` can differ.

The overlap check makes that order irrelevant. After the install, the step lists the executables in each directory that `mise env --paths` lists and in each workflow tool's bin directory. When an executable name appears in one of the action's directories and in a workflow tool's directory, and the two directories differ, the step fails, naming the executable and both directories. That failure is Hugi's own. The same install of the same version is one directory, so a tool that the config and the workflow pin alike passes. A tool under another backend, such as `npm:pnpm` beside the workflow's `pnpm`, a version from an idiomatic file such as `.nvmrc`, and a partial request that installs a different patch release all fail, where ADR-0006 lets the workflow tool win.

### Hugi's own failures

A failure marked *Hugi's own* is one that GitHub's runner would not have: Hugi stops because it cannot promise GitHub's result. It fails the lane even when the step sets `continue-on-error`, so the loud failure that the repository rule asks for is never swallowed.

### Later steps

Later steps get what the step wrote, through Hugi's handling of `GITHUB_ENV` and `GITHUB_PATH`: its `PATH` additions come before the tool environment's `PATH`, and its variables outrank the runner's variables and the tool environment's variables. Steps after an action step that ran, whether or not it succeeded, also run without Hugi's runner value of `MISE_IGNORED_CONFIG_PATHS`, so a shim or a step's own `mise` command reads the repository's config, as on GitHub's runner. A workflow or step that sets the variable itself still overrides this.

Each step keeps the workflow tools' per-tool version variables, as ADR-0006 decides. The check makes those versions the ones the config requests, so a shim for a workflow tool resolves the same requested version that it resolves on GitHub's runner.

### The `tools` key

The action needs no `tools` key in `.github/hugi.yaml`: the workflow already declares the source, and a lane with the default `tools: workflow` runs the action as described. A lane with `tools: mise` whose plan has a `jdx/mise-action` step fails before the VM boots, as a tool resolution failure does, with a message to remove `tools: mise`. Both would install from the same config by different rules, one with the lock file and `[env]` and one without. `hugi run --tools mise` behaves the same way.

### The steps before the checkout, and no config

The step needs no special case for these. Before the plan's `actions/checkout` step has run, the workspace is empty. With no config in the working directory, the check finds nothing to compare, `mise install` installs nothing, and `mise env` exports nothing beyond the action's own variables. The step succeeds, as the action does on GitHub's runner.

### Limits

These limits are accepted:

- The guest's mise is the golden image's, unless `version` names it exactly. Without `version`, GitHub's runner downloads the newest mise release that is older than `minimum_release_age`, so the two can differ in how they resolve or install a tool.
- Hugi reproduces v5.3.0. The moving `v5` tag, a later `v5` minor release, or a SHA pin can name a release whose behaviour differs.
- The shims directory holds shims for the image's installed tools as well as the config's, and steps after the action read the repository's config. So a command that neither the workflow nor the config pins, run as a shim, resolves through the repository's config and the image's global config, where GitHub's runner has no shim and runs its own program or none. A subdirectory's config that pins such a tool reaches it the same way. The same holds for a later step's own `mise run`, `mise exec`, or `mise env`, which still read the image's global config.
- With `install: false`, or with `install_args` naming a subset, a tool that the config requests and the image already holds is active under Hugi and missing on GitHub's runner.
- When the action re-adds the workflow tools' bin directories to `PATH`, they come ahead of directories that earlier steps added to `GITHUB_PATH`.
- Hugi passes no GitHub token into the VM ([ADR-0002](0002-verification-only.md)). The action passes the workflow's token to its own mise commands. A tool whose install calls GitHub's API can then meet a rate limit under Hugi that it would not meet on GitHub, and that fails the step.

Under `tools: mise`, the tool environment's variables win over the config's, so an image default's variable, such as `RUSTUP_TOOLCHAIN`, can override a tool the config pins. That does not happen for a tool that the action installs, because the action's variables come through `GITHUB_ENV`, which outranks the tool environment.

## Considered options

- **Run ADR-0006's "Install tools from mise config" step in the action's place.** One install path would serve both, but a lane with a lock file, an `[env]` table, or a command reached through a shim would get a different verdict from Hugi than from GitHub. Refusing the action's defaults would make a workflow set `env: false` and `add_shims_to_path: false`, which also changes the hosted job.
- **Reproduce GitHub's `PATH` order instead of checking for overlap.** Each setup action step would add its tools' directories to `PATH` at its own place. That matches GitHub's order, but it changes every setup action step from a no-op into a step, for a case that the overlap check turns into a loud failure.
- **Run local composite actions.** Loom's action would run as written, but a local action is an arbitrary script, and Hugi prefers declared tool pins to install scripts.
- **Substitute a step from `.github/hugi.yaml`.** The repository would tell Hugi to install Nushell through mise in place of its script. GitHub's runner would keep the script, so the two Nushell pins could drift, and shadow verdicts would disagree for reasons outside the code.
- **Recognise a `run:` step that installs mise.** Hugi cannot tell such a command apart from any other.
- **Allow `tools: mise` with the action.** The config would install twice, by two different rules, and the lane's tools would depend on which ran last.

## Consequences

- A workflow can install tools from its mise config, and its lanes run under Hugi with the same source on both sides. Loom can replace its Nushell script with the action and a `nushell` pin in `mise.toml`.
- A lane that uses the action has one more step that does real work in its report, under the action's own step number and name.
- Steps after the action can reach tools through mise's shims, so a version they run can depend on the directory they run in, as on GitHub's runner. The check covers the working directory's config only. A subdirectory's config is not compared, so for a workflow tool, the per-tool version variable wins under Hugi where a subdirectory pins it differently.
- A repository whose config and workflow both supply a tool, by another backend, an idiomatic version file, or a partial version, fails under Hugi until the two name one install.
- The action's inputs that Hugi cannot honour exactly fail the lane, as [supported actions](../supported-actions.md#jdxmise-action) lists.
