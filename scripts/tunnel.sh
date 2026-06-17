#!/usr/bin/env bash
# Open a PRIVATE, GitHub-authenticated tunnel from local :3055 to the Codespace
# bridge. Run this on your LOCAL machine (NOT inside the Codespace). No public
# port is ever created.
#
# Usage:
#   npm run tunnel                 # auto-detects the Codespace for this repo
#   bash scripts/tunnel.sh owner/repo   # explicit repo (if you have no local clone remote)
set -euo pipefail

PORT=3055
REPO="${1:-}"

if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
fi

NAME="$(gh codespace list ${REPO:+-R "$REPO"} --json name -q '.[0].name' 2>/dev/null || true)"

if [ -z "$NAME" ]; then
  echo "No Codespace found${REPO:+ for $REPO}." >&2
  echo "Create/resume one first, or pass the repo explicitly: bash scripts/tunnel.sh owner/repo" >&2
  exit 1
fi

echo "Tunneling  localhost:${PORT}  ->  Codespace ${NAME}  (private, no public port)"
echo "Keep this running while you use the plugin. Ctrl-C to stop."
exec gh codespace ports forward "${PORT}:${PORT}" -c "$NAME"
