#!/bin/sh
# Export the committed plugin files to a clean folder for `orca plugin dev load`.
# Orca hashes every file in a plugin folder and refuses symlinks, so the working
# repo (with .git, .codegraph and node_modules) cannot be loaded directly.
set -eu
dest="${UNIFIER_DEV_DIR:-$HOME/.local/share/orca-dev/unifier}"
root="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
  echo "orca:sync exports HEAD; commit or stash your changes first." >&2
  exit 1
fi
rm -rf "$dest"
mkdir -p "$dest"
git -C "$root" archive HEAD | tar -x -C "$dest"
echo "Exported $(git -C "$root" rev-parse --short HEAD) to $dest"
echo "Load it with: orca plugin dev load \"$dest\""
