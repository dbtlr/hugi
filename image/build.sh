#!/bin/bash
# Build the Hugi golden image: a tart VM cloned from the pinned macOS 15 base, with mise, the
# toolchains in tools.toml, and package caches warmed from warm.tsv.
#
#   image/build.sh [--replace] [name]
#
# name defaults to hugi-golden and must start with "hugi-". An existing image of that name is
# refused unless --replace is given; the new image is built under a temporary name and swapped
# in only after the build succeeds.
set -euo pipefail

# The cirruslabs macOS 15 base, pinned by digest.
BASE_IMAGE="ghcr.io/cirruslabs/macos-sequoia-base@sha256:4947ac5ab1b2fdc46ab856132d2ba958f8e45b5f85192c66370dafc028c514dd"
# The size runs use.
VM_CPU=4
VM_MEMORY_MB=4096

here="$(cd "$(dirname "$0")" && pwd)"
name="hugi-golden"
replace=0
for arg in "$@"; do
  case "$arg" in
    --replace) replace=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) name="$arg" ;;
  esac
done

die() { echo "build.sh: $*" >&2; exit 1; }
vm_exists() { tart list --quiet | grep -Fxq -- "$1"; }

if ! [[ $name =~ ^hugi-[A-Za-z0-9._-]+$ ]]; then
  die "image name must start with 'hugi-' and use only letters, digits, '.', '_' and '-': $name"
fi
command -v tart > /dev/null || die "tart is not installed"

if vm_exists "$name" && [ "$replace" -eq 0 ]; then
  die "$name already exists; pass --replace to rebuild it"
fi
# macOS allows two macOS guests at once and a run needs room, so build only on an idle host.
if tart list | awk '$1 == "local" && $NF == "running" { found = 1 } END { exit !found }'; then
  die "a VM is already running; stop it before building"
fi

tmp="hugi-build-$$"
old="hugi-old-$$"
vm_pid=""
log=""
swapping=0

# Stop and delete the temporary VM on every exit path. Only the VM this run created is touched.
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  # The new image is installed once the swap started and the temporary VM is gone.
  local installed=0
  [ "$swapping" -eq 1 ] && ! vm_exists "$tmp" && vm_exists "$name" && installed=1
  tart stop "$tmp" > /dev/null 2>&1
  [ -n "$vm_pid" ] && wait "$vm_pid" 2> /dev/null
  vm_exists "$tmp" && tart delete "$tmp"
  [ -n "$log" ] && rm -f "$log"
  # An interrupted swap: put the old image back if the new one never got its name.
  if vm_exists "$old"; then
    if vm_exists "$name"; then tart delete "$old"; else tart rename "$old" "$name"; fi
  fi
  if [ "$status" -ne 0 ]; then
    if [ "$installed" -eq 1 ]; then
      echo "build.sh: the new $name is installed, but the build did not finish cleanly; check tart list" >&2
    else
      echo "build.sh: build failed; $name is unchanged" >&2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

started=$(date +%s)
echo "== cloning the base image"
tart clone "$BASE_IMAGE" "$tmp"
tart set "$tmp" --cpu "$VM_CPU" --memory "$VM_MEMORY_MB"

echo "== booting $tmp"
log="$(mktemp -t hugi-build-vm)"
tart run "$tmp" --no-graphics --dir="image:$here:ro" > "$log" 2>&1 &
vm_pid=$!
# Wait for the guest agent, then for the shared directory, failing if the VM dies or stalls.
wait_for_guest() {
  local what=$1 deadline=$(( $(date +%s) + $2 ))
  shift 2
  until tart exec "$tmp" "$@" 2> /dev/null; do
    kill -0 "$vm_pid" 2> /dev/null || die "the VM stopped while waiting for $what: $(tail -3 "$log")"
    [ "$(date +%s)" -lt "$deadline" ] || die "timed out waiting for $what"
    sleep 1
  done
}
wait_for_guest "the guest agent" 300 true
wait_for_guest "the shared directory" 120 test -f "/Volumes/My Shared Files/image/provision.sh"

echo "== provisioning"
tart exec "$tmp" bash "/Volumes/My Shared Files/image/provision.sh"

echo "== shutting down"
tart stop "$tmp"
wait "$vm_pid" || true
vm_pid=""

# Swap in the new image only now that the build succeeded.
swapping=1
if vm_exists "$name"; then
  tart rename "$name" "$old"
  tart rename "$tmp" "$name" || die "could not install the new image"
  tart delete "$old"
else
  tart rename "$tmp" "$name"
fi

echo "== built $name in $(( $(date +%s) - started )) seconds"
tart list | awk -v n="$name" 'NR == 1 || $2 == n'
