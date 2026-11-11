#!/usr/bin/env bash
set -euo pipefail
umask 077
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$project_root"
command -v node >/dev/null || { printf '%s\n' 'Node.js 24 LTS is required. Nothing was installed.' >&2; exit 1; }
command -v npm >/dev/null || { printf '%s\n' 'npm is required. Nothing was installed.' >&2; exit 1; }
node -e 'if (process.versions.node.split(".")[0] !== "24") { console.error("Use Node.js 24 LTS; detected " + process.version); process.exit(1); }'
node scripts/setup.mjs
printf '%s\n' 'Next: npm ci --ignore-scripts' 'Development: npm run dev' 'Open http://127.0.0.1:5173 (or PUBLIC_URL in your existing .env).'
