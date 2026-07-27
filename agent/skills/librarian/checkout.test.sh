#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cache_root="$(mktemp -d)"
trap 'rm -rf "$cache_root"' EXIT

checkout="$cache_root/github.com/org/repo"
mkdir -p "$checkout"
git -C "$checkout" init -q
date +%s > "$checkout/.git/librarian-last-fetch"

actual="$(LIBRARIAN_CACHE_ROOT="$cache_root" bash "$script_dir/checkout.sh" git@github.com:org/repo.git --path-only)"
[[ "$actual" == "$checkout" ]]
[[ "$(git -C "$checkout" remote get-url origin)" == "git@github.com:org/repo.git" ]]

if LIBRARIAN_CACHE_ROOT="$cache_root" bash "$script_dir/checkout.sh" 'https://github.com/../../../.ssh/repo' --path-only >/dev/null 2>&1; then
  echo "path traversal input was accepted" >&2
  exit 1
fi
