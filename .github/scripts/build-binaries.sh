#!/usr/bin/env bash
# bun build --compile for every supported target, plus SHA256SUMS. Usage: build-binaries.sh <version> <outdir>
set -euo pipefail
version="$1"; out="$2"; mkdir -p "$out"
pinned="$(bun -e 'console.log(require("./packages/cli/package.json").version)')"
[[ "$pinned" == "$version" ]] || { echo "::error::tag v$version does not match packages/cli/package.json $pinned"; exit 1; }
for target in darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64; do
  ext=""; [[ "$target" == windows-* ]] && ext=".exe"
  bun build packages/cli/bin/ezil.ts --compile --target="bun-$target" --outfile "$out/ezil-$version-$target$ext"
done
(cd "$out" && sha256sum ezil-* > SHA256SUMS)
