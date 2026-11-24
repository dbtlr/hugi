---
type: adr
title: ADR-0007 - A workflow installs tools from its mise config with jdx/mise-action
description: Hugi runs a jdx/mise-action step at its own place in the job, doing what the action does on GitHub's runner, after checking the repository's mise config against the workflow tools. The action needs no tools key, and a lane that sets tools mise and uses the action fails.
status: accepted
created: 2026-11-24
modified: 2026-11-24
---
# ADR-0007 - A workflow installs tools from its mise config with jdx/mise-action

This record amends [ADR-0006](0006-a-lane-chooses-where-its-tools-come-from.md) in three places. It changes nothing else that ADR-0006 decides:

- ADR-0006 keeps `jdx/mise-action` an unsupported action under both values of `tools`. This record supports it under `tools: workflow` and refuses it under `tools: mise`.
- ADR-0006 runs every step with `MISE_IGNORED_CONFIG_PATHS` set to the workspace. Steps that run after a `jdx/mise-action` step run without it, as on GitHub's runner.
- ADR-0006 says a step never finds its tools through mise's shims. A step that runs after a `jdx/mise-action` step can, when the action puts the shims directory on `PATH`, as it does on GitHub's runner.

## Context

[ADR-0006](0006-a-lane-chooses-where-its-tools-come-from.md) gives a repository two sources of tools: its workflow's setup actions, and, with `tools: mise`, its mise config. A lane with `tools: mise` installs from the config under Hugi only. GitHub's runner has no mise, so the hosted job takes those tools from somewhere else, often a script. Loom's jobs install Nushell with a local composite action, a bash script that downloads a release and checks its SHA-256 sum. Hugi refuses local actions, so those lanes cannot run.

[`jdx/mise-action`](https://github.com/jdx/mise-action) installs mise on GitHub's runner and installs the tools that the repository's mise config requests. With it, the workflow itself declares "install the tools that `mise.toml` pins", and GitHub's runner and Hugi read the same file. Hugi can recognise the step by its action reference. A `run:` step that installs mise looks like any other command.

On GitHub's runner, the action does more than `mise install`. In its v5.3.0 defaults:

- it runs `mise install --locked` when it finds a mise lock file, so the lock file pins what installs;
- it exports what `mise env` prints to later steps: the config's `[env]` table, the tools' variables, and the `PATH` entries mise manages, `_.path` included;
- it puts mise's shims directory on `PATH` for later steps, and exports `MISE_TRUSTED_CONFIG_PATHS`, `MISE_YES`, and `MISE_LOG_LEVEL`;
- it succeeds with no config, installing nothing, and before the checkout.

ADR-0006's "Install tools from mise config" step does none of these. It turns the lock file off, leaves out `[env]`, keeps the shims off `PATH`, and fails when there is no config. A lane whose workflow uses the action would get a different verdict from Hugi than from GitHub if Hugi ran that step in the action's place.

## Decision

### Hugi does what the action does

Hugi runs a `jdx/mise-action` step at its own place in the job, as one of the job's steps. Its `if:`, `continue-on-error`, `timeout-minutes`, and `env` apply as to any step. The step does, in the guest, what the action does on GitHub's runner, in the action's order, for the inputs the [supported actions](../supported-actions.md#jdxmise-action) list accepts:

1. It writes the action's variables to `GITHUB_ENV`: `MISE_ENV` from `mise_env`; `MISE_EXPERIMENTAL=1` when `experimental` is true; `MISE_LOG_LEVEL` from `log_level`, `info` by default; `MISE_TRUSTED_CONFIG_PATHS` set to the workspace; and `MISE_YES=1`. As in the action, each variable except `MISE_ENV` is written only when the step's environment does not already set it.
2. When `version` is set, it checks that the guest's mise reports that version, and fails naming both versions when it does not. Without `version`, it uses the guest's mise.
3. When `add_shims_to_path` is true, the default, it adds the guest's shims directory to `GITHUB_PATH`.
4. When `reshim` is true, it runs `mise reshim -f`.
5. It checks the repository's config against the workflow tools, as described below.
6. When `install` is true, the default, it runs `mise install` in the working directory, followed by the tool names from `install_args`. It adds `--locked` when the action would: when a mise lock file lies in the working directory or one of its ancestors, matched by the names and places the action searches. When `monorepo` is true and the config sets `monorepo.config_roots`, the step fails, because Hugi does not reproduce a monorepo install.
7. When `env` is true, the default, it runs `mise env --json` in the working directory and writes every variable except `PATH` to `GITHUB_ENV`. When `export_path` is also true, the default, it adds the `PATH` entries that `mise env --paths` lists to `GITHUB_PATH`, in the order that keeps mise's first entry first.

The working directory is `working_directory` when set, a directory inside the workspace, and the workspace otherwise. A job's `defaults.run.working-directory` does not apply, because it applies only to `run:` steps.

The step writes its `GITHUB_ENV` and `GITHUB_PATH` additions as it goes. A failure partway through keeps the additions made before it, as on GitHub's runner, for any later step that still runs.

### What mise sees in the step

GitHub's runner starts with a fresh mise and no global config. The guest's mise has the image's global config, which pins the image's default tools. So the step's own mise commands run with the image's global config out of view: they read the repository's config only, and `mise env` exports only the repository's tools. The image's installed tools stay installed, and mise reuses one when the config requests its version.

The step's mise commands also run without `MISE_IGNORED_CONFIG_PATHS` and without the workflow tools' per-tool version variables, such as `MISE_NODE_VERSION`. GitHub's runner sets neither.

### The check against the workflow tools

Before it installs, the step reads the version that the repository's config requests for each tool, in the working directory. It then compares each with the workflow tools by the rules of ADR-0006's "Install tools from mise config" step: only entries whose source is a config file inside the workspace count, versions compare as written, and a tool requested at several versions fails. A disagreement fails the step and names the tool, both versions, and the file that pins the config's version.

The check exists because Hugi installs the workflow tools before the job's first step, while GitHub's runner installs each at its setup action's step. On `PATH`, the action's additions come before the workflow tools in every later step under Hugi. On GitHub, a setup action that runs after the action comes before it. With the check, both requested versions are the same, so the order cannot change which version of a tool a step runs, except as the limits below allow.

### Later steps

Later steps get what the step wrote, through Hugi's handling of `GITHUB_ENV` and `GITHUB_PATH`: its `PATH` additions come before the tool environment's `PATH`, and its variables outrank the runner's variables and the tool environment's variables. Steps after the action, whether or not it succeeded, also run without `MISE_IGNORED_CONFIG_PATHS`, so a shim or a step's own `mise` command reads the repository's config, as on GitHub's runner. A workflow or step that sets the variable itself still overrides this.

Each step keeps the workflow tools' per-tool version variables, as ADR-0006 decides. The check makes those versions the ones the config requests, so a shim resolves the same requested version that it resolves on GitHub's runner.

### The `tools` key

The action needs no `tools` key in `.github/hugi.yaml`: the workflow already declares the source, and a lane with the default `tools: workflow` runs the action as described. A lane with `tools: mise` whose plan has a `jdx/mise-action` step fails before the VM boots, as a tool resolution failure does, with a message to remove `tools: mise`. Both would install from the same config by different rules, one with the lock file and `[env]` and one without. `hugi run --tools mise` behaves the same way.

### The steps before the checkout, and no config

The step needs no special case for these. Before the plan's `actions/checkout` step has run, the workspace is empty. With no config in the working directory, the check finds nothing to compare, `mise install` installs nothing, and `mise env` exports nothing beyond the action's own variables. The step succeeds, as the action does on GitHub's runner.

### Limits

These limits are accepted:

- The guest's mise is the golden image's, unless `version` names it exactly. Without `version`, GitHub's runner downloads the newest mise release that is older than `minimum_release_age`, so the two can differ in how they resolve or install a tool.
- The check compares requested versions. A partial request such as `22` resolves when it installs, so a setup action and mise can install different patch releases, as they can on GitHub. The step order on `PATH` then decides which one a step runs, and Hugi's order can differ from GitHub's as described above.
- The shims directory holds shims for the image's installed tools as well as the config's. A shim for a tool that neither the workflow nor the config pins resolves to the image's default, whose version is the image's, as for the tool environment.
- Hugi passes no GitHub token into the VM ([ADR-0002](0002-verification-only.md)). The action passes the workflow's token to its own mise commands. A tool whose install calls GitHub's API can then meet a rate limit under Hugi that it would not meet on GitHub. That failure fails the step.

Under `tools: mise`, the tool environment's variables win over the config's, so an image default's variable, such as `RUSTUP_TOOLCHAIN`, can override a tool the config pins. That does not happen for a tool the action installs: the action's variables come through `GITHUB_ENV`, which outranks the tool environment.

## Considered options

- **Run ADR-0006's "Install tools from mise config" step in the action's place.** One install path would serve both, but a lane with a lock file, an `[env]` table, or a command reached through a shim would get a different verdict from Hugi than from GitHub. Refusing the action's defaults would make a workflow set `env: false` and `add_shims_to_path: false`, which also changes the hosted job.
- **Run local composite actions.** Loom's action would run as written, but a local action is an arbitrary script, and Hugi prefers declared tool pins to install scripts.
- **Substitute a step from `.github/hugi.yaml`.** The repository would tell Hugi to install Nushell through mise in place of its script. GitHub's runner would keep the script, so the two Nushell pins could drift, and shadow verdicts would disagree for reasons outside the code.
- **Recognise a `run:` step that installs mise.** Hugi cannot tell such a command apart from any other.
- **Allow `tools: mise` with the action.** The config would install twice, by two different rules, and the lane's tools would depend on which ran last.

## Consequences

- A workflow can install tools from its mise config, and its lanes run under Hugi with the same source on both sides. Loom can replace its Nushell script with the action and a `nushell` pin in `mise.toml`.
- A lane that uses the action has one more step that does real work in its report, under the action's own step number and name.
- Steps after the action can reach tools through mise's shims, so a version they run can depend on the directory they run in, as on GitHub's runner. The check covers the working directory's config only, so a subdirectory's config is not compared. A shim in that subdirectory resolves a tool the workflow does not pin to the subdirectory's version, as on GitHub. For a workflow tool, the per-tool version variable wins under Hugi, so a subdirectory that pins a workflow tool differently can run a different version than on GitHub.
- The action's inputs that Hugi cannot honour exactly fail the lane, as [supported actions](../supported-actions.md#jdxmise-action) lists.
