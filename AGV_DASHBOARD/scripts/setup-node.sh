#!/usr/bin/env bash
set -euo pipefail

RepoDir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
NodeVersion="22.19.0"
NodeDir="$RepoDir/.tools/node"
Archive="node-v${NodeVersion}-linux-x64.tar.xz"
DownloadUrl="https://nodejs.org/dist/v${NodeVersion}/${Archive}"
export PATH="$NodeDir/bin:$PATH"

if [[ ! -x "$NodeDir/bin/node" ]]; then
    TempDir="$(mktemp -d)"
    trap 'rm -rf -- "$TempDir"' EXIT
    echo "Mengunduh Node.js Linux v${NodeVersion}..."
    curl --fail --location --show-error --silent "$DownloadUrl" -o "$TempDir/$Archive"
    mkdir -p "$NodeDir"
    tar -xJf "$TempDir/$Archive" --strip-components=1 -C "$NodeDir"
fi

for AppDir in "$RepoDir/AGV_DASHBOARD/backend" "$RepoDir/AGV_DASHBOARD/frontend"; do
    echo "Memasang dependensi: ${AppDir#$RepoDir/}"
    (cd "$AppDir" && "$NodeDir/bin/npm" install)
done

echo "Siap. Node.js: $($NodeDir/bin/node --version)"
echo "Di VS Code pilih 'AGV: Run Both (Frontend + Backend)', lalu tekan F5."
