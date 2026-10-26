#!/usr/bin/env bash
# Local OS handoff only. Does not publish, install globally, or touch an existing output directory.
set -euo pipefail
out="${1:?Usage: build-private-cli.sh /absolute/new/output-directory}"
[[ "$out" = /* && ! -e "$out" ]] || { echo 'Output must be a new absolute directory.' >&2; exit 2; }
[[ "$(bun --version)" == '1.3.14' ]] || { echo 'Use Bun 1.3.14 (the repository pin).' >&2; exit 2; }
version="$(bun -e 'console.log(require("./packages/cli/package.json").version)')"
mkdir -p "$out"
bash .github/scripts/build-npm.sh "$version" "$out/package"
bun -e '
const path = process.argv[1];
const pkg = await Bun.file(path).json();
pkg.private = true;
delete pkg.publishConfig;
await Bun.write(path, JSON.stringify(pkg, null, 2) + "\n");
' "$out/package/package.json"
(cd "$out/package" && npm pack --ignore-scripts --silent --pack-destination "$out")
node "$out/package/dist/ezil.js" --version
{
  echo "commit=$(git rev-parse HEAD)"
  echo "version=$version"
  echo "bun=$(bun --version)"
  echo "node=$(node --version)"
  echo "npm=$(npm --version)"
  echo "trackedDiff=$(git diff HEAD --stat | tail -1)"
} > "$out/BUILD.txt"
(cd "$out" && sha256sum ./*.tgz package/dist/ezil.js > SHA256SUMS)
cat "$out/SHA256SUMS"
