#!/usr/bin/env bash
# Wait until <origin>/health reports this workflow's commit with its secrets bound.
set -euo pipefail
origin="$1"
for _ in $(seq 1 20); do
  health="$(curl --fail --silent --show-error --max-time 10 "$origin/health" || true)"
  if HEALTH="$health" bun -e 'const h = JSON.parse(process.env.HEALTH || "{}"); process.exit(h.ok === true && h.commit === process.env.GITHUB_SHA && h.configured === true ? 0 : 1)'; then
    echo "$origin serves $GITHUB_SHA"; exit 0
  fi
  sleep 3
done
echo "::error::$origin/health did not report $GITHUB_SHA with configured=true"; exit 1
