# Supported actions

`resolveToolchains(plan, readRepoFile)` in `src/toolchain/resolver.ts` resolves a whole step plan before the VM runner receives any tools. The file-reading port reads repository files at the same commit as the workflow and returns `undefined` for missing files. Resolution never reads the host's working copy or executes an action.

The result contains deduplicated mise specs in `tools`, an entry for each action in `actions`, and repository toolchain notes in `notes`. Each action entry retains its step index, name, and `uses` reference. It contains either one or more tool specs with any mapping notes, a no-op reason, or, for `jdx/mise-action`, the settings the step runs with. The caller can pass `tools` directly to `RunRequest.tools`. These are the lane's workflow tools. The VM runner installs them in an "Install tools" step and computes the tool environment from them, so each step finds them on `PATH` without mise's shims and keeps their `MISE_<TOOL>_VERSION` variables. After a `jdx/mise-action` step, later steps can also reach tools through the shims ([ADR-0007](decisions/0007-a-workflow-installs-tools-from-its-mise-config.md)). A lane with `tools: mise` also installs what the repository's mise config requests and fails when that disagrees with these pins ([ADR-0006](decisions/0006-a-lane-chooses-where-its-tools-come-from.md)). `hugi run` shows each action step in its report as the tools it resolved to or its no-op reason, followed by the notes. The checkout and a `jdx/mise-action` step run in the guest, so the report shows their results instead.

## Action mappings

Actions match by `owner/repo`, case-insensitively, with any nonempty ref containing no whitespace or `@`, except `jdx/mise-action`, whose ref must name major version 5 (below). Tags, branches, and SHA pins are accepted as written. The resolver does not require or validate SHA pins. YAML comments are already removed by the lane reader. A reference passed directly to the resolver with a trailing comment fails. Local actions, Docker actions, and action subdirectories are unsupported.

Every accepted input is listed below. Any other input fails the entire resolution, including inputs on no-op actions.

| Action | Accepted inputs | Resolution and reason |
| --- | --- | --- |
| `actions/checkout` | `persist-credentials` | No tools. The runner performs it without credentials: the workspace is empty until the plan's first `actions/checkout` step, which checks the commit out detached, at depth 1, with no tags. A later `actions/checkout` step is a no-op. The action's credential persistence input has no effect. |
| `actions/setup-node` | `node-version`, `cache`, `cache-dependency-path` | `node@<node-version>`. A missing version is unpinned and fails. `cache` accepts only `pnpm`, `npm`, or `yarn`. Each is a recorded no-op because the golden image holds warm package caches. `cache-dependency-path` is recorded in the cache note and never read; without `cache`, the note records it as unused. |
| `oven-sh/setup-bun` | `bun-version`, `bun-version-file` | `bun@<version>`. An explicit version and a version file are mutually exclusive. With neither input, the action defaults to `latest`, which fails as unpinned. Version files use the `.tool-versions` format described below. |
| `pnpm/action-setup` | `version` | `pnpm@<version>`. Resolution reads root `package.json` through the port. Without `version`, it uses the pnpm `devEngines.packageManager` version when present, as the action does, without checking `packageManager`; else the `packageManager` pin. If the action's `version` and `packageManager` both specify a version, they must agree. A missing or invalid pin fails. |
| `Swatinem/rust-cache` | None | No-op. The golden image holds warm Rust caches. |
| `actions/upload-artifact` | `name`, `path`, `if-no-files-found` | No-op. `path` is required, as the action requires it. Hugi publishes no artifacts, following [ADR-0002: verification only](decisions/0002-verification-only.md). `if-no-files-found` must be `warn`, `ignore`, or `error`, as GitHub requires; any other value fails. With `error`, the no-op reason records that the artifact path existence check is skipped. |
| `jdx/mise-action` | See [below](#jdxmise-action) | No workflow tools. The step runs in the guest at its own place, doing what the action does: it installs the tools the repository's mise config requests and exports mise's environment to later steps ([ADR-0007](decisions/0007-a-workflow-installs-tools-from-its-mise-config.md)). A lane with `tools: mise` that uses it fails. |

**Known gap:** Hugi does not check that the uploaded `path` exists. A lane whose build produces no output passes in Hugi where GitHub's `if-no-files-found: error` setting would fail the step.

**Known gap:** Hugi does not check that `cache-dependency-path` names a lockfile. With `cache` set, a path that matches no file fails the step on GitHub and passes in Hugi.

`node-version-file` is unsupported because the fixture lanes use `node-version`. Action inputs that install packages, run commands, select a different checkout, or provide credentials are outside these mappings.

### jdx/mise-action

The ref must be the moving tag `v5`, a release tag `v5.<minor>.<patch>` from `v5.3.0` on, or a 40-character commit SHA; any other ref fails resolution. Hugi reproduces v5.3.0 and cannot tell which release a SHA or the moving tag names, so it treats them as v5.3.0.

The inputs are those of v5.3.0. [ADR-0007](decisions/0007-a-workflow-installs-tools-from-its-mise-config.md) describes what the step does with them. A boolean input accepts `true`, `True`, `TRUE`, `false`, `False`, or `FALSE`, the values GitHub's runner accepts. Hugi refuses any other value, even for an input the action would not read.

| Inputs | Handling |
| --- | --- |
| `install`, `env`, `export_path`, `add_shims_to_path`, `reshim`, `experimental`, `monorepo` | Booleans, honoured as the action honours them. With `monorepo` true, a config that sets `monorepo.config_roots` fails the step, because Hugi does not reproduce a monorepo install. |
| `install_args` | Honoured. It must be tool names separated by spaces, such as `nushell pnpm`, each without `@` or a leading `-`. A version, a flag, a tab, a line break, a quote, or a backslash fails resolution. The action splits the value on spaces only and strips double quotes, so a tab, a line break, or a double quote would split differently there. It keeps a single quote and a backslash as written, and Hugi refuses them because no tool name contains them. |
| `working_directory` | Honoured. It must be a relative path without parent traversal, inside the workspace. A leading `./` is accepted. |
| `log_level`, `mise_env` | Honoured: exported as `MISE_LOG_LEVEL` and `MISE_ENV`, as the action exports them. |
| `version` | Checked: the guest's mise must report this version, with any leading `v` dropped, or the step fails and names both versions. A `mise --version` that fails for this check fails the step too. Both failures fail the lane even under `continue-on-error`. |
| `cache`, `cache_save`, `cache_save_post`, `cache_key`, `cache_key_prefix` | No-op. The golden image holds mise's installs. Boolean inputs follow the rule above. |
| `cache_max_age_days` | No-op. It must be a non-negative integer, as the action requires, or resolution fails. |
| `cache_restore_retry_budget`, `cache_save_retry_budget` | No-op. Each must be a duration the action accepts, such as `60s`, `2m`, or `0s`, or resolution fails, as the action fails before it runs. |
| `minimum_release_age` | No-op. It must be a relative duration made of whole numbers with the units `y`, `mo`, `w`, `d`, `h`, `m`, or `s`, such as `24h` or `1d12h`, or a whole number of seconds. Hugi refuses other values, including the ISO dates the action also accepts. |
| `auto_update`, `fetch_from_github` | No-op. They choose how GitHub's runner downloads mise. Hugi uses the golden image's mise, so the two can differ unless `version` pins it. |
| `mise_toml`, `tool_versions`, `mise_dir`, `install_dir`, `plugins`, `bootstrap_skip`, `bootstrap_args`, `sha256` | Refused unless empty. They write config files from the workflow, move mise's directories, install plugins or run bootstrap tasks, which are arbitrary code, or verify a mise binary that Hugi does not download. |
| `bootstrap`, `wings_enabled` | Refused unless `false`, in a form the boolean rule accepts. |
| `github_token`, `persist_github_token` | `github_token` is refused when set. `persist_github_token` is refused unless it is `false`. Both carry credentials into the VM ([ADR-0002](decisions/0002-verification-only.md)). |

Any other input fails resolution. The lane reader already refuses `steps.<id>.outputs` expressions, so the action's `versions` and `cache-hit` outputs need no handling.

**Known gap:** Hugi's mise is the golden image's unless `version` pins it, and GitHub's runner downloads the newest release older than `minimum_release_age`.

**Known gap:** Hugi does not read `cache_key`. A value that is not a valid Handlebars template fails the action on GitHub when `cache` is true, and passes in Hugi.

**Known gap:** Hugi passes no GitHub token, so a tool install that calls GitHub's API can meet a rate limit under Hugi that it does not meet on GitHub.

**Known gap:** A step whose environment sets `SHELLOPTS`, `IFS`, `POSIXLY_CORRECT`, `POSIX_PEDANTIC`, `TMOUT` or a `BASH_FUNC_*` function fails before its first command, naming the variable, even with `continue-on-error`. Hugi runs the action's mise commands in a bash of its own, which those variables would change. Set them on the `run:` steps that need them instead. A `BASH_ENV` or `ENV` reaches the action's mise and the programs it runs, as on GitHub.

The action exports mise's variables with `core.exportVariable`, and GitHub's runner reads them back from `GITHUB_ENV`. Hugi reads them the same way, so a name such as `FOO-BAR` reaches the later steps, and a name the file cannot carry, such as `A=B` or `C<<D`, fails the step with the runner's message. As on the runner, the variables before the bad name still reach the later steps and the ones after it do not, and `A=B` still sets `A`, to `B<<` followed by the toolkit's delimiter.

## Versions and repository files

Numeric versions, including partial versions such as `22` and `22.23`, pass through as written. Numeric versions can have a leading `v`, a prerelease suffix, or build metadata. A prerelease suffix must contain a digit to pin a specific build, such as `1.2.0-rc.1`. Bare moving aliases such as `22-nightly`, `22-rc`, and `1.2-canary` fail as unpinned. Digits in build metadata do not make a prerelease suffix pinned. Other aliases and ranges such as `latest`, `lts/*`, `x`, `22.x`, `^22`, and `>=22` also fail. Two different strings for the same tool conflict, even when one could include the other, such as `22` and `22.23.2`. Repeated identical pins install once. Tools retain their first-use order.

`bun-version-file` is a repository-relative path without parent traversal. A leading `./` is accepted and dropped. Its contents must have exactly one `bun` entry and exactly one version on that entry, in asdf-style `.tool-versions` format. Other tool entries and comments are ignored. A missing file, missing Bun entry, duplicate Bun entry, or unpinned version fails. For example:

```text
bun 1.4.4
```

The pnpm resolver reads only the root `package.json`, even when the action supplies `version`. If present, `packageManager` must be a string such as `pnpm@12.16.1`. A Corepack integrity suffix such as `+sha512.abcdef1234` is accepted and removed before comparison and from the mise spec. An explicit action `version` and a `packageManager` version must match exactly. A mismatch fails with `Multiple versions of pnpm specified`. An explicit `version` works when the manifest or `packageManager` is absent. A malformed manifest fails. An invalid `packageManager` fails, even with an explicit `version`, unless `devEngines.packageManager` supplies the version.

Resolution also reads root Rust toolchain files for every lane, even when no action mentions Rust, because Cargo honors them. Following rustup's precedence, `rust-toolchain` takes priority over `rust-toolchain.toml` when both exist. Only the selected file is parsed. An invalid `rust-toolchain` fails without falling back to `rust-toolchain.toml`.

The legacy `rust-toolchain` file accepts a plain one-line channel, optionally ending in a newline, or a TOML document with `[toolchain] channel`. The `rust-toolchain.toml` file accepts only TOML with `[toolchain] channel`. The channel produces `rust@<channel>`. Numeric pins and dated channels such as `nightly-2026-10-01` are accepted. Bare `stable`, `beta`, and `nightly` are unpinned and fail. Missing or malformed channels fail when the selected file exists. Components and profile remain rustup's responsibility in the guest, recorded in `notes` with the selected filename. Subdirectory toolchain files are out of scope and are not read.

## Supported workflow syntax

The lane reader (`src/lane/`) reads the lane's job and refuses what it cannot carry, so a lane that uses an unsupported key fails with a fail verdict instead of running differently from GitHub. The whole file must also be one GitHub accepts: an unknown top-level key, a job with neither `runs-on` nor `uses`, a `needs` cycle, or a duplicate step id fails every lane in it.

**Job keys.** The lane's job accepts `concurrency`, `defaults`, `env`, `if`, `name`, `needs`, `outputs`, `permissions`, `runs-on`, `steps`, `strategy`, and `timeout-minutes`. Hugi ignores `concurrency`, `outputs`, and `permissions`. Any other key fails, including `container`, `services`, `environment`, `uses`, `with`, `secrets`, and `continue-on-error`. Job-level `continue-on-error` is refused because no enrolled lane uses it, and accepting it means deciding what an allowed-to-fail lane reports. Step-level `continue-on-error` is supported.

**Nested keys.** `strategy` accepts `fail-fast`, `matrix`, and `max-parallel`. `defaults` accepts only `run`, and `run` accepts only `shell` and `working-directory`. Workflow-level `defaults.run` cannot hold an expression.

**Step keys.** Every step takes `continue-on-error`, `env`, `id`, `if`, `name`, and `timeout-minutes`, and has exactly one of `run` or `uses`. A `run` step also takes `shell` and `working-directory`. A `uses` step also takes `with`.

**YAML merge keys.** A `<<` key anywhere in the job, the workflow's `env`, or the workflow's `defaults` fails the read. GitHub does not support merge keys.

**Step `env` context.** An expression in a step that reads `env.*` fails, because an earlier step can change `env` through `GITHUB_ENV`. Job-level and workflow-level `env` follow GitHub's context rules: the workflow's `env` cannot read `env`, `job`, `matrix`, `needs`, `runner`, `steps`, or `strategy`, and the job's cannot read `env`, `job`, `runner`, or `steps`.

**Runner labels.** `runs-on` must be one Apple-silicon label, compared without regard to case: `macos-latest`, `macos-14`, `macos-15`, `macos-26`, or any of these with `-xlarge` added. Intel (`macos-13`, `-large`, `-intel`), self-hosted, Linux, and unknown labels fail, as does a list of more than one label.

**Shells.** A `run` step with no `shell`, and no `defaults.run.shell`, runs as `bash -e {0}`, without `pipefail`, as on GitHub's macOS runners. An explicit `shell: bash` runs as `bash --noprofile --norc -eo pipefail {0}`, and `shell: sh` as `sh -e {0}`. Any other shell fails.

**Job-level `if:`.** It can read the `github` and `needs` contexts. `env`, `job`, `matrix`, `runner`, `secrets`, `steps`, and `strategy` are refused as GitHub refuses them, and `inputs` and `vars` fail because Hugi has no values for them. A job whose `if:` is false for the event has no lane to run, and `hugi run` exits with a usage error.

## Failures

Resolution rejects with a `ToolchainResolutionError` and returns no partial result. Action failures use its `UnsupportedActionError` subtype and name the step index, step name, action reference, and reason. Conflicting pins name both versions and their source steps. Repository Rust errors name the selected `rust-toolchain` or `rust-toolchain.toml` file. A resolution failure is a fail verdict, with one exception: when the file-reading port cannot read a repository file at all (a source read failure, as opposed to a missing or invalid file), the run yields no verdict, because the failure lies outside the lane. `hugi run` tells the two apart; see the [glossary](glossary.md).

## Fixture sources

The tests build step plans with `readLane` from the committed workflow fixtures under `src/lane/fixtures/`. Only these additional repository files are needed, copied verbatim under `src/toolchain/fixtures/`:

| Repository | Commit | File |
| --- | --- | --- |
| `dbtlr/norn` | `7e71dfe81` | `rust-toolchain.toml` |
| `dbtlr/mimir` | `810a1fb3f` | `.tool-versions` |

Both Loom fixture lanes explicitly supply pnpm's version. Their fixture repository files omit the package manifests.

## Adding an action

1. Add a resolver test for the action's intended behavior and run it before implementing the mapping. Cover unsupported inputs and unpinned versions where relevant.
2. Add its mapping and explicit input allowlist under `src/toolchain/`. Return pinned mise specs or a no-op with a reason. Reject behavior that the VM cannot preserve.
3. Read any repository files through `readRepoFile` at the lane's commit. Keep the workflow as the only definition of the lane's steps.
4. Update the action table and any fixture evidence. Run `bun run check` and `bun run test`.
