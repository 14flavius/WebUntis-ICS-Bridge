#!/bin/sh
set -eu
umask 077
cd /app
node --input-type=module -e 'import { readConfig } from "./dist/server/config.js"; readConfig();'
[ -d /app/data ] && [ -w /app/data ] || { printf '%s\n' 'The persistent data directory must be writable by the node user.' >&2; exit 1; }
# The server applies additive application/Better Auth migrations before listening.
exec node dist/server/index.js
