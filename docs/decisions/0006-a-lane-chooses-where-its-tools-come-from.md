---
type: adr
title: ADR-0006 - A lane chooses where its tools come from
description: A lane entry in .github/hugi.yaml takes an optional tools key. With workflow, the default, only the workflow's setup actions and toolchain files supply tools, and the guest ignores the repository's mise config. With mise, mise in the guest installs from the repository's mise config, and a tool Hugi also resolved from the workflow at a different version fails the lane.
status: accepted
created: 2026-11-19
modified: 2026-11-25
---
# ADR-0006 - A lane chooses where its tools come from

This record amends [ADR-0004](0004-lanes-declared-in-hugi-yaml.md) in two places, and [ADR-0001](0001-github-never-schedules.md) in one: the first sentence of its Consequences, which states the same rule as ADR-0004's second passage below. It changes nothing else that either decides:

- It adds a fourth key, `tools`, to the lane entry, whose keys ADR-0004 lists as closed.
- A lane that sets `tools: mise` takes its tools from the repository's mise config as well as from its job. That narrows the rule that the job's workflow file is the lane's only definition: for such a lane, it remains the only definition of what runs, but not of which tools are installed. ADR-0004's rule that each lane has exactly one definition at every stage is about where the job is defined, in GitHub's workflow or in a Hugi workflow, and still holds.

## Context

The golden image installs [mise](https://mise.jdx.dev) and trusts every config file under the guest's home directory. Each step also runs with `MISE_TRUSTED_CONFIG_PATHS` set to the workspace. Once a lane's `actions/checkout` step has run, mise reads the repository's own config whenever a step calls a tool through a mise shim. That covers `mise.toml`, `.tool-versions`, local and `conf.d` files, the configs of subdirectories, and the lockfile. A tool pinned there that the workflow never installs is then installed and used by the lane's steps. Trust is no guard either: with `CI` set, which the guest sets as GitHub's runner does, mise reads an untrusted config without asking.

GitHub's macOS runner has no mise, so the same config does nothing there. A lane can therefore pass under Hugi only because a tool came from a file GitHub ignores. During shadow, that is a disagreement with the hosted result that has nothing to do with the code. Loom and Mimir both carry such files: Loom's `mise.toml` pins pnpm, and Mimir's `.tool-versions` pins bun.

Some repositories keep their tool versions in their mise config, and want their Hugi lanes to install from it. That is a deliberate choice for each lane, and the lane declaration is where a repository makes choices about its lanes (ADR-0004).

## Decision

### The key

A lane entry in `.github/hugi.yaml` takes one more optional key, `tools`. Its value is the string `workflow` or `mise`, and the default is `workflow`:

```yaml
lanes:
  - workflow: ci.yml
    jobs: [platform]
  - workflow: ci.yml
    jobs: [node_macos]
    tools: mise
```

The value applies to every lane of the entry. It is not part of a lane's identity, so it does not change the lane's status name. Any other value, including another type, refuses the declaration as a schema error, as ADR-0004 refuses other schema errors.

`hugi run` takes the same choice as `--tools workflow|mise`, with the same default. The coordinator passes the entry's value.

Under either value, Hugi resolves the workflow's tools as before: from the job's setup actions and the repository's Rust toolchain files, as [supported actions](../supported-actions.md) describes. These are the **workflow tools**. The "Install tools" step installs them before the plan's steps.

### How a step finds its tools

A step no longer finds its tools through mise's shims, which resolve a version again on every call from the directory the step runs in, and so read the repository's config. Instead, Hugi computes the **tool environment** once, after "Install tools": `mise env --json` run in a directory outside the workspace, against the guest's base `PATH` without the shims directory, with the workflow tools' per-tool version variables set and with `MISE_NO_ENV=1`, so no config's `[env]` table, `_.path` included, enters it. Every step then runs with that environment's `PATH` and the variables it exports, such as `RUSTUP_TOOLCHAIN` for Rust, and keeps the per-tool version variables, so a step's own call to `mise` agrees with them. A tool on that `PATH` runs directly, and mise is not consulted again. [ADR-0007](0007-a-workflow-installs-tools-from-its-mise-config.md) amends this for the steps after a `jdx/mise-action` step, which can also find tools through mise's shims. [ADR-0008](0008-a-config-pinned-tool-wins-over-the-image-default.md) amends this: for a `tools: mise` lane, the same step also writes the workflow tools' bin directories and their environment alone. The tool environment holds the workflow tools and the image's default tools, as a GitHub runner's `PATH` holds what its setup actions installed and what the runner image ships, though the defaults' versions are the image's, not the runner's.

Each step also runs with `MISE_IGNORED_CONFIG_PATHS` set to the workspace and without `MISE_TRUSTED_CONFIG_PATHS` ([ADR-0007](0007-a-workflow-installs-tools-from-its-mise-config.md) amends both for the steps after a `jdx/mise-action` step), so a step that runs `mise` itself does not read the repository's config files. A workspace `.miserc.toml` can still select a profile of the image's global config for such a step. The guarantees here are about the tools on `PATH`; what a step that runs `mise` gets is the workflow's own doing. This variable is a runner variable, the lowest layer of a step's environment, so a workflow or step can override it. [ADR-0007](0007-a-workflow-installs-tools-from-its-mise-config.md) amends this: steps after a `jdx/mise-action` step run without it. GitHub's runner has no mise, so no workflow sets it for GitHub's sake, and a step that runs `mise` would fail there.

### `tools: workflow`

The tool environment is the lane's only source of tools. Nothing in the repository's mise config affects which tool a step runs, in any directory, whatever the config, local, `conf.d`, `.miserc.toml`, or lockfile files say. [ADR-0007](0007-a-workflow-installs-tools-from-its-mise-config.md) amends this for a lane whose job runs `jdx/mise-action`, which installs from the config from that step on.

### `tools: mise`

mise in the guest reads the repository's config, at the workspace root only. Hugi does not read the config on the host. When the plan's `actions/checkout` step has run and succeeded, Hugi runs one more step of its own straight after it, "Install tools from mise config", in the workspace root, with the environment the "Install tools" step has, with the workspace trusted, and without `MISE_IGNORED_CONFIG_PATHS`:

1. It lists the config files mise loads at the workspace root (`mise config ls --json`). When none of them lies inside the workspace, after resolving symbolic links, the step fails, because the declaration asked for a source that is not there.
2. It reads, without the workflow tools' version variables, the version that the repository's config requests for each tool (`mise ls --current --json`), under mise's own name for the tool (`nodejs` and `core:node` are `node`). Only entries whose source is a config file inside the workspace count. An entry whose source is an idiomatic version file, such as `rust-toolchain.toml`, does not, because Hugi already resolves those as workflow tools.
3. For each workflow tool that the config also requests, it compares the two requested versions as written, as two workflow pins are compared. When they differ, or when the config requests several versions of that tool, the step fails and names the tool, both versions, and the file that pins it. One version is the source of truth, and a disagreement is reported instead of being settled silently.
4. It runs `mise install` with mise's lockfile turned off (`MISE_LOCKFILE=false`), and computes the config's tool environment in the workspace root, the same way as the first one. The later steps run with a `PATH` of three parts, without duplicates: first the bin directories of the workflow tools, then the config's tool environment's `PATH` in its own order, then the rest of the first tool environment's `PATH`. The first environment's variables win over the config environment's. So a tool the config pins runs ahead of the image's default and the base `PATH`, and nothing in the config can move a workflow tool's pin, not a tool alias, `disable_tools`, or `[env]`. [ADR-0008](0008-a-config-pinned-tool-wins-over-the-image-default.md) amends this: the config environment's variables win over the image defaults', and the guarantee covers a workflow tool's place on `PATH` and the variables it sets.

The lockfile is off so that a lockfile written on a developer's machine does not pin a version that the workflow tools would resolve differently, and so that the checkout is never rewritten. A request is then met by an installed version that matches it, such as one the image already holds, or else by the newest matching release.

A failure in this step is the lane's verdict, as a failure in "Install tools" is. When the checkout step does not run, the step does not run either, and the lane has only the workflow tools. A lane with `tools: mise` whose plan has no `actions/checkout` step fails before the VM boots, as a tool resolution failure does. That depends only on the lane, but it is a fault in the lane's tools, which ADR-0004 gives to the run, so it does not refuse the declaration.

The config's `[env]` table is not applied to the steps, because the tool environment is computed with `MISE_NO_ENV=1`. The config of a subdirectory is not read. A tool that only a subdirectory's config names is not installed.

These guarantees have limits, which are accepted:

- The check compares requested versions. Two equal partial requests, such as `22`, resolve at install time, so they can install different patch releases on Hugi and on GitHub's runner, as they could between two runs on GitHub.
- An idiomatic version file that the config enables, such as `.nvmrc`, is not compared. A workflow tool's pin still wins over it on `PATH`.
- A tool that the config requests under another backend, such as `npm:pnpm` beside the workflow's `pnpm`, is a different tool to mise. Its executables come later on `PATH` than the workflow tool's, and the check does not compare them.
- On GitHub, the same job installs its tools with setup actions. So in shadow, a `tools: mise` lane differs from the hosted job in any tool that only the mise config names. That is a choice the repository makes.

`jdx/mise-action` stays an unsupported action under both values. [ADR-0007](0007-a-workflow-installs-tools-from-its-mise-config.md) amends this: a lane with `tools: workflow` runs the action, and a lane with `tools: mise` that uses it fails.

## Considered options

- **Keep trusting the repository's config for every lane.** This needs no change, but every lane can pick up tools GitHub's runner would not have, which makes shadow verdicts disagree for reasons outside the code.
- **Withdraw trust from the workspace.** With `CI` set, mise still reads untrusted config, so this changes nothing in the guest.
- **Keep the shims and ignore the workspace's config with `MISE_IGNORED_CONFIG_PATHS`.** A workspace `.miserc.toml` still changes which version a shim runs, and each shim call resolves again from its directory, so a guarantee checked once would not hold for every step.
- **Read the mise config on the host and add its tools to the "Install tools" step.** The host would have to reproduce mise's discovery: local and `conf.d` files, subdirectories, `.miserc.toml` redirects, tool aliases, and lockfiles. Anything it missed would install or resolve differently in the guest from what the host checked.
- **Ignore the repository's mise config with no way back.** A repository that keeps its tool versions in mise would have to repeat each one in setup actions.
- **Let the mise config win silently over workflow tools.** One version would install, but the workflow would claim another, and GitHub's runner would use the workflow's. A loud failure keeps the two in agreement.
- **Choose per repository in Hugi's configuration.** This contradicts ADR-0004's rule that the repository says what to run.

## Consequences

- Every lane now finds its tools on a computed `PATH` instead of through mise's shims. The phase-1 lanes have to pass again on the golden image to show that nothing they ran relied on a shim.
- A lane that relied on a tool from the repository's mise config fails under the default until its workflow installs that tool or its entry sets `tools: mise`. That failure is the disagreement with GitHub's runner that the default exists to show.
- A `tools: mise` lane has one more step in its report, and its conflict check runs in the VM, after the boot and the checkout, not before the VM boots.
- With `tools: mise`, the config's `[settings]` table still applies when mise installs and resolves the config's tools, so a setting can change which version is installed. That is the repository's choice, and the step's log shows what was installed.
- `hugi run` gains `--tools`. A lane run by hand without it behaves as the default.
