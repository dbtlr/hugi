#!/bin/bash
# Measure suspend/resume against cold boot, and find the concurrent-VM limit.
set -u
cd "$(dirname "$0")"
now() { python3 -c 'import time; print(time.time())'; }
since() { python3 -c "import sys,time; print(f'{time.time()-float(sys.argv[1]):.1f}')" "$1"; }
ready() { until tart exec "$1" true 2>/dev/null; do sleep 0.2; done; }

echo "== suspend and resume"
tart clone ci-timing-base ci-timing-a
t=$(now); tart run ci-timing-a --no-graphics --suspendable > vm-a.log 2>&1 &
ready ci-timing-a; echo "cold boot (suspendable): $(since "$t") s"
tart exec ci-timing-a bash -c 'echo marker-$$ > /tmp/marker; cat /tmp/marker; uptime'
t=$(now); tart suspend ci-timing-a; wait; echo "suspend: $(since "$t") s"
tart list | grep ci-timing-a | awk '{print "state after suspend:", $NF}'
du -sh ~/.tart/vms/ci-timing-a | awk '{print "VM directory size:", $1}'
ls -la ~/.tart/vms/ci-timing-a | awk '{print $5, $9}' | tail -6
for i in 1 2 3; do
  t=$(now); tart run ci-timing-a --no-graphics --suspendable > vm-a.log 2>&1 &
  ready ci-timing-a; echo "resume $i: $(since "$t") s"
  tart exec ci-timing-a bash -c 'cat /tmp/marker; uptime'
  tart suspend ci-timing-a; wait
done

echo "== resume a clone of the suspended VM"
t=$(now); tart clone ci-timing-a ci-timing-b; echo "clone of suspended VM: $(since "$t") s"
t=$(now); tart run ci-timing-b --no-graphics --suspendable > vm-b.log 2>&1 &
ready ci-timing-b; echo "clone resume to ready: $(since "$t") s"
tart exec ci-timing-b bash -c 'cat /tmp/marker 2>/dev/null || echo "no marker: clone cold-booted"; uptime'

echo "== third and fourth concurrent VM"
t=$(now); tart run ci-timing-a --no-graphics --suspendable > vm-a.log 2>&1 &
ready ci-timing-a; echo "second VM resumed while one runs: $(since "$t") s"
tart clone ci-timing-base ci-timing-c
tart run ci-timing-c --no-graphics > vm-c.log 2>&1 &
cpid=$!
for i in $(seq 1 60); do
  if tart exec ci-timing-c true 2>/dev/null; then echo "third VM came up"; break; fi
  if ! kill -0 "$cpid" 2>/dev/null; then echo "third VM refused:"; cat vm-c.log; break; fi
  sleep 1
done
tart list | grep ci-timing | awk '{print $2, $NF}'
memory_pressure | tail -1; sysctl -n vm.swapusage

tart stop ci-timing-a > /dev/null 2>&1; tart stop ci-timing-b > /dev/null 2>&1; tart stop ci-timing-c > /dev/null 2>&1
wait
tart delete ci-timing-a; tart delete ci-timing-b; tart delete ci-timing-c
tart list | grep ci-timing | awk '{print "remaining:", $2}'
