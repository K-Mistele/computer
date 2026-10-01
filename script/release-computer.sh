#!/usr/bin/env bash
# Publish this fork's @cloudflare/computer as a GitHub release asset, so a
# project can depend on it by URL without an npm registry:
#
#   "@cloudflare/computer": "https://github.com/<owner>/computer/releases/download/<tag>/cloudflare-computer-<version>.tgz"
#
# The release is tagged fold-<short commit>, cut from HEAD, which must
# already be pushed. Build computerd from the same commit so the durable
# object and the container always run matching code.
#
# Usage: script/release-computer.sh [owner/repo]   (default: the origin remote)

set -euo pipefail

cd "$(dirname "$0")/.."

repo="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
commit="$(git rev-parse HEAD)"
tag="fold-$(git rev-parse --short=12 HEAD)"

if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has uncommitted changes; commit and push them first." >&2
  exit 1
fi
if ! git branch -r --contains "$commit" | grep -q .; then
  echo "HEAD ($commit) is not on any remote branch; push it first." >&2
  exit 1
fi

npm run build --workspace @cloudflare/dofs --workspace @cloudflare/computer-rpc --workspace @cloudflare/computer

out="$(mktemp -d)"
npm pack --workspace @cloudflare/computer --pack-destination "$out" >/dev/null
tarball="$(ls "$out"/*.tgz)"

gh release create "$tag" "$tarball" \
  --repo "$repo" \
  --target "$commit" \
  --title "$tag" \
  --notes "@cloudflare/computer built from $commit. Build computerd from the same commit."

echo
echo "commit:  $commit"
echo "package: https://github.com/$repo/releases/download/$tag/$(basename "$tarball")"
