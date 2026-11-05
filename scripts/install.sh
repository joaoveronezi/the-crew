#!/usr/bin/env bash
# Install the crew skill into a repository (.claude/skills/crew) or for your user (~/.claude/skills/crew).
#   scripts/install.sh <path-to-repo>
#   scripts/install.sh --user
set -euo pipefail

src="$(cd "$(dirname "$0")/.." && pwd)/skill"
case "${1:-}" in
  --user) dest="$HOME/.claude/skills/crew" ;;
  "" | -h | --help) sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
  *)
    repo="$(cd "$1" && git rev-parse --show-toplevel)" || { echo "not a git repository: $1" >&2; exit 1; }
    dest="$repo/.claude/skills/crew"
    ;;
esac

if [ -e "$dest" ] && [ -z "${FORCE:-}" ]; then
  echo "$dest already exists. Re-run with FORCE=1 to replace it." >&2
  exit 1
fi
rm -rf "$dest"
mkdir -p "$(dirname "$dest")"
cp -R "$src" "$dest"
echo "Installed the crew skill in $dest"

if [ -n "${repo:-}" ]; then
  missing=()
  for p in .claude/loops/ .worktrees/; do
    git -C "$repo" check-ignore -q "$p" || missing+=("$p")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "Add these to $repo/.gitignore: ${missing[*]}"
  fi
fi
