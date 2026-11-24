#!/bin/bash
# Runs inside the build VM (started by build.sh): installs mise and the toolchains from
# tools.toml, then warms the package caches listed in warm.tsv and removes the clones.
# The image directory is mounted at "/Volumes/My Shared Files/image".
set -euo pipefail

SHARE="/Volumes/My Shared Files/image"
WARM_DIR="$HOME/hugi-warm"
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1
# Shims first: the base image carries its own Homebrew node and pnpm.
export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:$PATH"

# fish is a program loomcli's tests start; its workflow runs `brew install fish`, which is a
# no-op when the formula is already here.
# HOMEBREW_NO_AUTO_UPDATE keeps `brew install` from refreshing the formula index, so a mise the
# base image already holds would stay at the base image's release. Refresh it and upgrade mise.
brew update --quiet
brew install mise fish
brew upgrade mise

# A jdx/mise-action step needs these flags and reproduces none of the action's fallbacks for older
# releases (ADR-0007), so an image whose mise lacks one fails here instead of in every such lane.
for need in 'env --paths' 'env --json' 'install --locked'; do
  set -- $need
  if ! mise "$1" --help | grep -qE -- "(^|[[:space:]])$2([[:space:],]|$)"; then
    echo "mise $(mise --version) lacks mise $need, which a jdx/mise-action step needs" >&2
    exit 1
  fi
done

mkdir -p "$HOME/.config/mise"
cp "$SHARE/tools.toml" "$HOME/.config/mise/config.toml"
mise install --yes
mise reshim

# Put the shims on PATH for login shells and interactive bash, for people who open a shell in the
# VM. A plain `tart exec` command or a non-interactive, non-login bash (`bash -c`) reads none of
# these files, and a run does not use the shims: it computes the tool environment with `mise env`
# and sets PATH itself (ADR-0006).
# shellcheck disable=SC2016  # the line is written literally; the shell expands it at login
shim_path='export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:$PATH"'
for rc in .zshenv .zprofile .bash_profile .bashrc; do
  grep -qxF "$shim_path" "$HOME/$rc" 2>/dev/null || echo "$shim_path" >> "$HOME/$rc"
done

mkdir -p "$WARM_DIR"
export CI=true
while IFS=$'\t' read -r url rev command; do
  case "$url" in ''|'#'*) continue ;; esac
  name=$(basename "$url" .git)
  echo "== warming $name @ $rev: $command"
  git clone --quiet "$url" "$WARM_DIR/$name"
  git -C "$WARM_DIR/$name" checkout --quiet --detach "$rev"
  (cd "$WARM_DIR/$name" && bash -ec "$command")
done < "$SHARE/warm.tsv"

# A run must never see a stale source tree. The package-manager caches stay.
rm -rf "$HOME/hugi-warm"
brew cleanup --prune=all > /dev/null

echo "== installed tools"
mise ls --current
