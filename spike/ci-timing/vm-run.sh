#!/bin/bash
# Run one lane in a fresh VM cloned from ci-timing-base, then delete the VM.
#   vm-run.sh <slot a|b> <lane> <label> <condition>
# Appends one row to vm-results.tsv: lane, label, condition, clone, boot, lane
# seconds, lane exit, host load, host swap used (MB), failed step if any.
set -u
slot=$1; lane=$2; label=$3; cond=$4
here="$(cd "$(dirname "$0")" && pwd)"
case "$slot" in a) vm=ci-timing-a ;; b) vm=ci-timing-b ;; *) echo "slot must be a or b"; exit 2 ;; esac
now() { python3 -c 'import time; print(time.time())'; }
since() { python3 -c "import sys,time; print(f'{time.time()-float(sys.argv[1]):.1f}')" "$1"; }

t=$(now); tart clone ci-timing-base "$vm"; clone=$(since "$t")
[ -n "${VM_CPU:-}" ] && tart set "$vm" --cpu "$VM_CPU"
[ -n "${VM_MEM:-}" ] && tart set "$vm" --memory "$VM_MEM"
t=$(now); tart run "$vm" --no-graphics > "$here/vm-$slot.log" 2>&1 &
runpid=$!
until tart exec "$vm" true 2>/dev/null; do
  sleep 0.5
  if ! kill -0 "$runpid" 2>/dev/null; then
    printf '%s\t%s\t%s\t-\t-\t-\tvm-refused\t-\t-\t%s\n' "$lane" "$label" "$cond" "$(tail -1 "$here/vm-$slot.log")" >> "$here/vm-results.tsv"
    case "$slot" in a) tart delete ci-timing-a ;; b) tart delete ci-timing-b ;; esac
    exit 1
  fi
done
boot=$(since "$t")
load=$(sysctl -n vm.loadavg | awk '{print $2}')

t=$(now)
tart exec "$vm" bash -c "export PATH=\$HOME/.local/share/mise/shims:/opt/homebrew/bin:\$PATH; cd \$HOME/ci && python3 harness.py $lane $label cold run/w" > "$here/vm-$slot.$lane.$label.out" 2>&1
rc=$(tail -1 "$here/vm-$slot.$lane.$label.out")
secs=$(since "$t")
failed=$(tart exec "$vm" bash -c "awk -F'\t' '\$7!=\"0\" && \$5!=\"TOTAL\"{print \$5}' \$HOME/ci/results.tsv" 2>/dev/null | tr '\n' ';')
swap=$(sysctl -n vm.swapusage | awk '{print $6}')
mkdir -p "$here/vm-logs/$lane.$label"
tart exec "$vm" bash -c "cd \$HOME/ci && tar cf - logs results.tsv" 2>/dev/null | tar xf - -C "$here/vm-logs/$lane.$label" 2>/dev/null

tart stop "$vm" > /dev/null 2>&1
wait
case "$slot" in a) tart delete ci-timing-a ;; b) tart delete ci-timing-b ;; esac
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$lane" "$label" "$cond" "$clone" "$boot" "$secs" "$rc" "$load" "$swap" "$failed" >> "$here/vm-results.tsv"
