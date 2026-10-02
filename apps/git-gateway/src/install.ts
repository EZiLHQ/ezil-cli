/**
 * The EZiL CLI installers, served at https://github.ezil.work/install.sh and /install.ps1.
 *
 * Both download the standalone binary for this machine from /cli/<version>/ (R2 `ezil-cli-releases`, uploaded by the
 * ezil-cli release job), check it against SHA256SUMS before installing anything, and install for the current user
 * only: no sudo, no admin. `EZIL_VERSION` pins a version, `EZIL_INSTALL_DIR` picks the directory.
 */

export const INSTALL_SH = `#!/bin/sh
# EZiL CLI installer.   curl -fsSL https://github.ezil.work/install.sh | sh
set -eu
BASE="\${EZIL_DOWNLOAD_BASE:-https://github.ezil.work}"
DIR="\${EZIL_INSTALL_DIR:-$HOME/.local/bin}"
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "ezil: unsupported OS $(uname -s). On Windows: irm https://github.ezil.work/install.ps1 | iex" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "ezil: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac
version="\${EZIL_VERSION:-$(curl -fsSL "$BASE/cli/latest")}"
file="ezil-$version-$os-$arch"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading ezil $version for $os-$arch"
curl -fsSL "$BASE/cli/$version/$file" -o "$tmp/ezil"
curl -fsSL "$BASE/cli/$version/SHA256SUMS" -o "$tmp/SHA256SUMS"
want="$(awk -v f="$file" '$2 == f { print $1 }' "$tmp/SHA256SUMS")"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/ezil" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/ezil" | cut -d' ' -f1)"; fi
if [ -z "$want" ] || [ "$want" != "$got" ]; then echo "ezil: checksum mismatch; nothing was installed" >&2; exit 1; fi
mkdir -p "$DIR"
chmod +x "$tmp/ezil"
mv "$tmp/ezil" "$DIR/ezil"
echo "Installed ezil $version to $DIR/ezil"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "Add it to your PATH first:   export PATH=\\"$DIR:\\$PATH\\"" ;;
esac
echo "Next:   ezil auth login"
`;

export const INSTALL_PS1 = `# EZiL CLI installer.   irm https://github.ezil.work/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$base = if ($env:EZIL_DOWNLOAD_BASE) { $env:EZIL_DOWNLOAD_BASE } else { 'https://github.ezil.work' }
$version = if ($env:EZIL_VERSION) { $env:EZIL_VERSION } else { (Invoke-RestMethod "$base/cli/latest").Trim() }
$file = "ezil-$version-windows-x64.exe"
$dir = if ($env:EZIL_INSTALL_DIR) { $env:EZIL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\\ezil' }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$tmp = Join-Path ([IO.Path]::GetTempPath()) $file
Write-Host "Downloading ezil $version for windows-x64"
Invoke-WebRequest "$base/cli/$version/$file" -OutFile $tmp -UseBasicParsing
$sums = [Text.Encoding]::UTF8.GetString((Invoke-WebRequest "$base/cli/$version/SHA256SUMS" -UseBasicParsing).RawContentStream.ToArray())
$want = ($sums -split "\`n" | ForEach-Object { $p = $_.Trim() -split '\\s+'; if ($p.Count -eq 2 -and $p[1] -eq $file) { $p[0] } }) | Select-Object -First 1
$got = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
if (-not $want -or $want -ne $got) { Remove-Item $tmp; throw 'ezil: checksum mismatch; nothing was installed' }
Move-Item -Force $tmp (Join-Path $dir 'ezil.exe')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ((($userPath -split ';') -notcontains $dir)) { [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User'); Write-Host "Added $dir to your PATH; open a new terminal." }
Write-Host "Installed ezil $version to $dir\\ezil.exe"
Write-Host 'Next:   ezil auth login'
`;
