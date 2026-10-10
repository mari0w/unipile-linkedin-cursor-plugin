#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/server"
cd "$SERVER"
if [[ ! -d node_modules/@modelcontextprotocol/sdk ]]; then
  npm install --omit=dev --no-fund --no-audit >/dev/null
fi
exec node "$SERVER/index.js"
