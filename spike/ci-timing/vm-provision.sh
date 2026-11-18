#!/bin/bash
# Provision the throwaway base VM: toolchains, sources, and warm global package
# caches (one priming run per lane), as a prepared runner image would carry.
set -euo pipefail
export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:$PATH" HOMEBREW_NO_AUTO_UPDATE=1
SHARE="/Volumes/My Shared Files/ci"

brew install mise fish
mise use -g node@22.23.2 pnpm@12.16.1 bun@1.4.4 rust@1.97.1 powershell-core@latest
mise reshim

mkdir -p "$HOME/ci/src"
cp "$SHARE/harness.py" "$HOME/ci/harness.py"
cd "$HOME/ci/src"
for repo in norn-next loomcli mimir; do
  [ -d "$repo" ] || git clone -q "https://github.com/dbtlr/$repo.git" "$repo"
done
cd "$HOME/ci"
python3 harness.py preflight > /dev/null
for lane in norn-platform loom-node loom-bun mimir-build; do
  python3 harness.py "$lane" prime cold "prime-$lane/w" || echo "PRIME FAILED: $lane"
done
grep TOTAL results.tsv || true
