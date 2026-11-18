#!/bin/bash
# Re-run a completed GitHub Actions run's macOS job(s) on the same commit and
# record queue and run time for each attempt.
#   gh-reruns.sh <owner/repo> <run id> <job name filter, or "ALL" to re-run the whole run> <attempts>
set -u
repo=$1; run=$2; filter=$3; last=$4
out="$(dirname "$0")/github.tsv"

record() { # attempt
  gh api "repos/$repo/actions/runs/$run/attempts/$1/jobs?per_page=50" \
    -q ".jobs[] | select(.name | test(\"mac\"; \"i\")) | [\"$repo\", \"$1\", .name, .conclusion, (.runner_name // \"none\"), (if .started_at then ((.started_at|fromdate)-(.created_at|fromdate)) else -1 end), (if .started_at and .completed_at then ((.completed_at|fromdate)-(.started_at|fromdate)) else -1 end), .created_at] | @tsv" >> "$out"
}

attempt=$(gh api "repos/$repo/actions/runs/$run" -q .run_attempt)
[ "$attempt" = 1 ] && record 1
while [ "$attempt" -lt "$last" ]; do
  if [ "$filter" = ALL ]; then
    gh run rerun "$run" -R "$repo" || { echo "$repo: rerun refused at attempt $attempt"; exit 1; }
  else
    job=$(gh api "repos/$repo/actions/runs/$run/attempts/$attempt/jobs?per_page=50" -q ".jobs[] | select(.name | test(\"$filter\")) | .id")
    gh run rerun "$run" -R "$repo" --job "$job" || { echo "$repo: rerun refused at attempt $attempt"; exit 1; }
  fi
  attempt=$((attempt + 1))
  sleep 20
  until [ "$(gh api "repos/$repo/actions/runs/$run" -q '[.run_attempt, .status] | @tsv')" = "$attempt	completed" ]; do sleep 30; done
  record "$attempt"
  echo "$repo: attempt $attempt recorded"
done
