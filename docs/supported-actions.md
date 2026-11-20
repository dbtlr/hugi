# Supported actions

`resolveToolchains(plan, readRepoFile)` in `src/toolchain/resolver.ts` resolves a whole step plan before the VM runner receives any tools. The file-reading port reads repository files at the same commit as the workflow and returns `undefined` for missing files. Resolution never reads the host's working copy or executes an action.

The result contains deduplicated mise specs in `tools`, an entry for each action in `actions`, and repository toolchain notes in `notes`. Each action entry retains its step index, name, and `uses` reference. It contains either one or more tool specs with any mapping notes, or a no-op reason. The caller can pass `tools` directly to `RunRequest.tools`. These are the lane's workflow tools. The VM runner installs them in an "Install tools" step and computes the tool environment from them, so each step finds them on `PATH` without mise's shims and keeps their `MISE_<TOOL>_VERSION` variables. A lane with `tools: mise` also installs what the repository's mise config requests and fails when that disagrees with these pins ([ADR-0006](decisions/0006-a-lane-chooses-where-its-tools-come-from.md)). `hugi run` shows each action step in its report as the tools it resolved to or its no-op reason, followed by the notes.

## Action mappings

Actions match by `owner/repo`, case-insensitively, with any nonempty ref containing no whitespace or `@`. Tags, branches, and SHA pins are accepted as written. The resolver does not require or validate SHA pins. YAML comments are already removed by the lane reader. A reference passed directly to the resolver with a trailing comment fails. Local actions, Docker actions, and action subdirectories are unsupported.

Every accepted input is listed below. Any other input fails the entire resolution, including inputs on no-op actions.

| Action | Accepted inputs | Resolution and reason |
| --- | --- | --- |
| `actions/checkout` | `persist-credentials` | No tools. The runner performs it without credentials: the workspace is empty until the plan's first `actions/checkout` step, which checks the commit out detached, at depth 1, with no tags. A later `actions/checkout` step is a no-op. The action's credential persistence input has no effect. |
| `actions/setup-node` | `node-version`, `cache` | `node@<node-version>`. A missing version is unpinned and fails. `cache` accepts only `pnpm`, `npm`, or `yarn`. Each is a recorded no-op because the golden image holds warm package caches. |
| `oven-sh/setup-bun` | `bun-version`, `bun-version-file` | `bun@<version>`. An explicit version and a version file are mutually exclusive. With neither input, the action defaults to `latest`, which fails as unpinned. Version files use the `.tool-versions` format described below. |
| `pnpm/action-setup` | `version` | `pnpm@<version>`. Resolution reads root `package.json` through the port. Without `version`, it uses the pnpm `devEngines.packageManager` version when present, as the action does, without checking `packageManager`; else the `packageManager` pin. If the action's `version` and `packageManager` both specify a version, they must agree. A missing or invalid pin fails. |
| `Swatinem/rust-cache` | None | No-op. The golden image holds warm Rust caches. |
| `actions/upload-artifact` | `name`, `path`, `if-no-files-found` | No-op. `path` is required, as the action requires it. Hugi publishes no artifacts, following [ADR-0002: verification only](decisions/0002-verification-only.md). `if-no-files-found` must be `warn`, `ignore`, or `error`, as GitHub requires; any other value fails. With `error`, the no-op reason records that the artifact path existence check is skipped. |

**Known gap:** Hugi does not check that the uploaded `path` exists. A lane whose build produces no output passes in Hugi where GitHub's `if-no-files-found: error` setting would fail the step.

`node-version-file` is unsupported because the fixture lanes use `node-version`. Action inputs that install packages, run commands, select a different checkout, or provide credentials are outside these mappings.

## Versions and repository files

Numeric versions, including partial versions such as `22` and `22.23`, pass through as written. Numeric versions can have a leading `v`, a prerelease suffix, or build metadata. A prerelease suffix must contain a digit to pin a specific build, such as `1.2.0-rc.1`. Bare moving aliases such as `22-nightly`, `22-rc`, and `1.2-canary` fail as unpinned. Digits in build metadata do not make a prerelease suffix pinned. Other aliases and ranges such as `latest`, `lts/*`, `x`, `22.x`, `^22`, and `>=22` also fail. Two different strings for the same tool conflict, even when one could include the other, such as `22` and `22.23.2`. Repeated identical pins install once. Tools retain their first-use order.

`bun-version-file` is a repository-relative path without parent traversal. A leading `./` is accepted and dropped. Its contents must have exactly one `bun` entry and exactly one version on that entry, in asdf-style `.tool-versions` format. Other tool entries and comments are ignored. A missing file, missing Bun entry, duplicate Bun entry, or unpinned version fails. For example:

```text
bun 1.4.4
```

The pnpm resolver reads only the root `package.json`, even when the action supplies `version`. If present, `packageManager` must be a string such as `pnpm@12.16.1`. A Corepack integrity suffix such as `+sha512.abcdef1234` is accepted and removed before comparison and from the mise spec. An explicit action `version` and a `packageManager` version must match exactly. A mismatch fails with `Multiple versions of pnpm specified`. An explicit `version` works when the manifest or `packageManager` is absent. A malformed manifest fails. An invalid `packageManager` fails, even with an explicit `version`, unless `devEngines.packageManager` supplies the version.

Resolution also reads root Rust toolchain files for every lane, even when no action mentions Rust, because Cargo honors them. Following rustup's precedence, `rust-toolchain` takes priority over `rust-toolchain.toml` when both exist. Only the selected file is parsed. An invalid `rust-toolchain` fails without falling back to `rust-toolchain.toml`.

The legacy `rust-toolchain` file accepts a plain one-line channel, optionally ending in a newline, or a TOML document with `[toolchain] channel`. The `rust-toolchain.toml` file accepts only TOML with `[toolchain] channel`. The channel produces `rust@<channel>`. Numeric pins and dated channels such as `nightly-2026-10-01` are accepted. Bare `stable`, `beta`, and `nightly` are unpinned and fail. Missing or malformed channels fail when the selected file exists. Components and profile remain rustup's responsibility in the guest, recorded in `notes` with the selected filename. Subdirectory toolchain files are out of scope and are not read.

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
