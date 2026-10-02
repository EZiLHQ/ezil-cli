#!/usr/bin/env bash
# Wait until <origin>/health reports this workflow's commit (or, with `any`, any commit) with its secrets bound.
set -euo pipefail
origin="$1"; expected="${2:-$GITHUB_SHA}"
for _ in $(seq 1 20); do
  health="$(curl --fail --silent --show-error --max-time 10 "$origin/health" || true)"
  if HEALTH="$health" EXPECTED="$expected" bun -e 'const h = JSON.parse(process.env.HEALTH || "{}"); process.exit(h.ok === true && (process.env.EXPECTED === "any" || h.commit === process.env.EXPECTED) && h.configured === true ? 0 : 1)'; then
    echo "$origin serves ${expected/any/a configured version}"; exit 0
  fi
  sleep 3
done
echo "::error::$origin/health did not report $expected with configured=true"; exit 1
