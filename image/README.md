# Golden image

`build.sh` builds the tart VM image that every Hugi lane runs in. Each run clones the image, runs one lane, and deletes the clone.

## Usage

```sh
image/build.sh [--replace] [name]
```

- `name` defaults to `hugi-golden` and must start with `hugi-`, so the script can never touch another VM.
- If `name` exists, the script stops unless you pass `--replace`. The new image is built under a temporary name and replaces the old one only after the build succeeds. A failed build leaves the old image in place.
- The host needs only [tart](https://tart.run) and network access. Nothing is read from other VMs or from local source clones.
- The build refuses to start while any VM is running, because macOS allows two macOS guests at once.
- The build VM has 4 CPUs and 4 GB of memory, the size runs use. The temporary VM is stopped and deleted on every exit path.

The first build downloads the base image (about 33 GB) and takes roughly 15 to 30 minutes. A later build starts from the cached base.

## What the image holds

| Part | Source |
| --- | --- |
| macOS 15 base | `ghcr.io/cirruslabs/macos-sequoia-base`, pinned by digest in `build.sh` |
| mise, fish | Homebrew, in the base image or installed during the build |
| Node, pnpm, Bun, Rust (with clippy and rustfmt), PowerShell | [`tools.toml`](tools.toml), installed by mise as the global config |
| Warm package caches | [`warm.tsv`](warm.tsv): one install per enrolled lane, then the clone is deleted |

The mise shims directory comes first on `PATH` in `.zshenv`, `.zprofile`, `.bash_profile` and `.bashrc`, so zsh and login or interactive bash find the pinned tools ahead of the base image's Homebrew copies. A plain `tart exec` command or a non-interactive, non-login bash (`bash -c`) reads none of these files and finds the Homebrew copies first, so Hugi's VM runner puts the shims directory first on `PATH` for every step, unless the workflow sets `PATH` itself. The image holds no secrets.

### Enrolled lanes

| Repository | Lane | Tools |
| --- | --- | --- |
| `dbtlr/norn-next` | determinism and filesystem (macOS ARM64) | Rust from `rust-toolchain.toml` |
| `dbtlr/loomcli` | `node / macos-latest`, `bun / macos-latest` | Node, pnpm, Bun, fish, PowerShell |
| `dbtlr/mimir` | `build mimir-darwin-arm64` | Bun |

## Add a toolchain

1. Add the tool and version to `tools.toml`, with a comment naming where the pin comes from.
2. If the lane has dependencies worth caching, add a line to `warm.tsv`: repository URL, revision, install command, separated by tabs.
3. Run `image/build.sh --replace`.

## Check an image

```sh
vm="hugi-check-$$"
if tart clone hugi-golden "$vm"; then
  tart run "$vm" --no-graphics &
  # Wait up to five minutes for the guest agent before checking the tools.
  for _ in $(seq 60); do tart exec "$vm" true 2>/dev/null && break; sleep 5; done
  tart exec "$vm" zsh -lc 'cargo --version && node --version && bun --version && pnpm --version'
  tart stop "$vm"; tart delete "$vm"
fi
```

A fresh name per check means a VM left by an earlier check is never reused or deleted by mistake.
