#!/usr/bin/env bash
# Build the publishable @ezilhq/cli npm package: one Node ES module bundle (the CLI plus its contract), a package.json
# without workspace dependencies, README and LICENSE. Usage: build-npm.sh <version> <outdir>
set -euo pipefail
version="$1"; out="$2"
pinned="$(bun -e 'console.log(require("./packages/cli/package.json").version)')"
[[ "$pinned" == "$version" ]] || { echo "::error::v$version does not match packages/cli/package.json $pinned"; exit 1; }
rm -rf "$out"; mkdir -p "$out/dist"
bun build packages/cli/bin/ezil.ts --target=node --outfile "$out/dist/ezil.js"
# The source runs under Bun; the package runs under Node.
sed -i '1s|^#!.*|#!/usr/bin/env node|; 2{/^\/\/ @bun$/d}' "$out/dist/ezil.js"
chmod +x "$out/dist/ezil.js"
cp README.md "$out/README.md"; cp LICENSE "$out/LICENSE"
VERSION="$version" bun -e '
const pkg = {
  name: "@ezilhq/cli", version: process.env.VERSION,
  description: "EZiL command line: sign in, clone and push EZiL repositories with plain git (github.ezil.work), session evidence for EZiL Works.",
  type: "module", bin: { ezil: "dist/ezil.js" }, files: ["dist", "README.md", "LICENSE"],
  engines: { node: ">=18" }, license: "UNLICENSED",
  repository: { type: "git", url: "git+https://github.com/EZiLHQ/ezil-cli.git" },
  homepage: "https://github.com/EZiLHQ/ezil-cli#readme", bugs: "https://github.com/EZiLHQ/ezil-cli/issues",
  keywords: ["ezil", "git", "credential-helper", "cli"], publishConfig: { access: "public" },
};
await Bun.write(process.argv[1] + "/package.json", JSON.stringify(pkg, null, 2) + "\n");' "$out"
echo "built $out (@ezilhq/cli $version)"
