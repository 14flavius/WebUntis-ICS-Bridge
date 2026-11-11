#!/bin/sh
set -eu
umask 077

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

if [ "${1:-}" = '--help' ]; then
  printf '%s\n' \
    'Usage: sh scripts/backup.sh [--docker]' \
    'Prompts for a passphrase and creates an encrypted, consistent backup.' \
    'Docker installations: a folder in ./backups holds the encrypted backup,' \
    'docker-compose.yml.backup and the image ID.' \
    'Source checkouts: the backup is written to data/backups. Use --docker to' \
    'back up a Compose instance from a checkout instead.'
  exit 0
fi

# An installation directory has the Compose file but no application source.
mode=local
if [ "${1:-}" = '--docker' ] || { [ -f docker-compose.yml ] && [ ! -f package.json ]; }; then
  mode=docker
fi
if [ "$mode" = docker ] && [ ! -f .env ]; then
  fail 'Missing .env; backup stopped.'
fi

read_secret() {
  printf '%s' "$1" >&2
  # Hide typing on a terminal; piped input (automation) has nothing to hide.
  if [ -t 0 ]; then
    stty -echo
    trap 'stty echo' EXIT
    trap 'stty echo; exit 1' HUP INT TERM
  fi
  IFS= read -r secret_value || secret_value=
  if [ -t 0 ]; then
    stty echo
    trap - EXIT HUP INT TERM
  fi
  printf '\n' >&2
}

read_secret 'Backup passphrase (at least 12 characters): '
passphrase=$secret_value
[ "${#passphrase}" -ge 12 ] || fail 'Passphrase is too short.'
read_secret 'Repeat passphrase: '
[ "$passphrase" = "$secret_value" ] || fail 'Passphrases do not match.'
unset secret_value

if [ "$mode" = local ]; then
  printf '%s' "$passphrase" | node --env-file-if-exists=.env scripts/backup.mjs create
  unset passphrase
  exit 0
fi

[ -f docker-compose.yml ] || fail 'Missing docker-compose.yml; backup stopped.'
container=$(docker compose ps --quiet bridge)
[ -n "$container" ] || fail 'The bridge is not running. Start it with: docker compose up -d --wait'

mkdir -p backups
backup=$(mktemp -d "./backups/$(date -u +%Y%m%d-%H%M%S)-XXXXXX")
finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "Backup incomplete: $backup. Do not use it to restore." >&2
  fi
}
trap finish EXIT
trap 'exit 1' HUP INT TERM

# The application takes a consistent online snapshot; it does not need to stop.
output=$(printf '%s' "$passphrase" | docker compose exec -T bridge node scripts/backup.mjs create)
unset passphrase
printf '%s\n' "$output"
created=$(printf '%s\n' "$output" | sed -n 's/^Encrypted backup created: //p')
[ -n "$created" ] || fail 'The backup was not created.'
docker compose cp "bridge:/app/$created" "$backup/$(basename "$created")"
# The secrets are inside the encrypted file; .env is not copied in plain text.
cp docker-compose.yml "$backup/docker-compose.yml.backup"
docker inspect --format '{{.Image}}' "$container" > "$backup/image-id.txt"
printf '%s\n' 'Complete encrypted backup; restore with the matching image.' > "$backup/COMPLETE"
printf '%s\n' "Backup saved: $backup" 'Store a protected copy and the passphrase outside this server.'
