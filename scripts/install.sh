#!/bin/sh
set -eu
umask 077

# Download this script as install.sh into the directory that will hold the instance.
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

if [ "${1:-}" = '--help' ]; then
  printf '%s\n' \
    'WebUntis ICS Bridge Docker installer.' \
    'Run it in a new, empty directory: sh install.sh' \
    'It asks for the instance name, browser URL, host port and listen address,' \
    'writes .env and docker-compose.yml, prepares ./data, then downloads and starts the image.' \
    'Existing installations are never overwritten.'
  exit 0
fi

for existing in .env docker-compose.yml docker-compose.yaml compose.yml compose.yaml .git data scripts/backup.sh scripts/prepare-data.sh; do
  if [ -e "$existing" ] || [ -L "$existing" ]; then
    printf '%s\n' "Existing $existing found. Nothing changed." >&2
    if [ -f .env ] && [ -f docker-compose.yml ]; then
      printf '%s\n' \
        'Restart this instance: docker compose restart bridge' \
        'Start a stopped instance: docker compose start bridge' \
        'To change settings, edit .env in this installation directory: nano .env' \
        'Keep BETTER_AUTH_SECRET, ENCRYPTION_KEY and COMPOSE_PROJECT_NAME unchanged.' \
        'Apply your changes with: docker compose up -d --pull never --wait' \
        'For image updates, follow the backup/update instructions in the README.' >&2
    else
      printf '%s\n' \
        'Keep or restore the original .env and Compose configuration; see the README.' >&2
    fi
    exit 1
  fi
done
if [ -L scripts ]; then
  fail 'The scripts directory must not be a symbolic link.'
fi
if [ -f ../package.json ] && [ -f ../docker-compose.yml ]; then
  fail 'This is a source checkout. Use bash scripts/setup.sh from its root instead.'
fi

for tool in curl openssl docker; do
  command -v "$tool" >/dev/null 2>&1 || fail "Install $tool before running this installer."
done
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required.'
docker info >/dev/null 2>&1 || fail 'Docker is not running or is not accessible.'

if [ -n "${COMPOSE_PROJECT_NAME:-}${COMPOSE_FILE:-}${COMPOSE_ENV_FILES:-}${BETTER_AUTH_SECRET:-}${ENCRYPTION_KEY:-}${PUBLIC_URL:-}${HOST_PORT:-}${BIND_ADDRESS:-}${BRIDGE_IMAGE:-}" ]; then
  fail 'Unset exported bridge/Compose configuration variables before installing; settings will be saved in .env.'
fi

valid_port() {
  printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[1-9][0-9]{0,4}$' &&
    [ "$1" -le 65535 ]
}

valid_instance_name() {
  case "$1" in
    ''|[-_]*|*[!a-z0-9_-]*) return 1 ;;
  esac
  [ "${#1}" -le 63 ]
}

default_instance=$(basename "$PWD")
if ! valid_instance_name "$default_instance"; then
  default_instance=webuntis-ics-bridge
fi
printf '%s\n' \
  'WebUntis ICS Bridge - new Docker installation' \
  '' \
  'Each instance needs its own directory, instance name and host port.' \
  'The instance name identifies its Docker Compose containers; keep it unchanged later.'
printf 'Instance name [%s]: ' "$default_instance"
IFS= read -r instance_name || fail 'Input closed. No configuration was created.'
instance_name=${instance_name:-$default_instance}
valid_instance_name "$instance_name" ||
  fail 'Use 1-63 lowercase letters, digits, dashes or underscores; start with a letter or digit.'

containers=$(docker ps --all --quiet --filter "label=com.docker.compose.project=$instance_name")
if [ -n "$containers" ]; then
  fail "Instance '$instance_name' already has containers. Use its original directory to start/restart it, or choose a different name."
fi

printf '%s\n' \
  '' \
  'Browser URL: the full address you will use to open the bridge.' \
  '  Public HTTPS / reverse proxy: https://calendar.example.com' \
  '  Local access only:            http://localhost:3000' \
  'Behind an HTTPS proxy, enter the public https:// domain even though the container uses HTTP.' \
  'Plain HTTP is only accepted for localhost or 127.0.0.1; every other address needs HTTPS.' \
  'Sign-in only works through exactly this address.' \
  ''
printf '%s' 'Browser URL [http://localhost:3000]: '
IFS= read -r instance_url || fail 'Input closed. Run sh install.sh in an interactive terminal.'
instance_url=${instance_url:-http://localhost:3000}
instance_url=${instance_url%/}
if ! printf '%s\n' "$instance_url" | LC_ALL=C grep -Eq '^(https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|http://(localhost|127\.0\.0\.1))(:[0-9]{1,5})?$'; then
  fail 'Use an https:// address, or http://localhost / http://127.0.0.1, without credentials, a subpath, query or fragment.'
fi
authority=${instance_url#*://}
url_port=
case "$authority" in
  *:*) url_port=${authority##*:} ;;
esac
if [ -n "$url_port" ] && ! valid_port "$url_port"; then
  fail 'The URL port must be between 1 and 65535.'
fi
default_port=3000
case "$instance_url" in
  http://*) default_port=${url_port:-80} ;;
esac
printf '\n%s\n' \
  'Host port: the HTTP port published on your Docker host (usually 3000).' \
  'Your reverse proxy forwards to this port; the public HTTPS URL stays unchanged.' \
  'For another instance, choose a different host port (for example 3001).'
printf 'Host port [%s]: ' "$default_port"
IFS= read -r host_port || fail 'Input closed. No configuration was created.'
host_port=${host_port:-$default_port}
valid_port "$host_port" || fail 'The host port must be between 1 and 65535.'

printf '%s\n' \
  '' \
  'Listen address: who can reach the HTTP port, independent of your browser URL.' \
  '1) Local access / reverse proxy running directly on this host (127.0.0.1)' \
  '2) LAN / all host interfaces (0.0.0.0)' \
  'A proxy in another container needs Docker network access; see the README.'
printf '%s' 'Listen on [1]: '
IFS= read -r exposure || fail 'Input closed. No configuration was created.'
case "${exposure:-1}" in
  1) bind_address=127.0.0.1 ;;
  2) bind_address=0.0.0.0 ;;
  *) fail 'Choose 1 or 2.' ;;
esac

temporary=$(mktemp -d .bridge-install.XXXXXX)
trap 'rm -rf "$temporary"' EXIT
trap 'exit 1' HUP INT TERM
source_url=https://raw.githubusercontent.com/14flavius/webuntis-ics-bridge/main
download() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 120 "$source_url/$1" -o "$2"
}

# Finish all downloads and checks before publishing any configuration.
download docker-compose.yml "$temporary/docker-compose.yml"
download scripts/backup.sh "$temporary/backup.sh"
download scripts/prepare-data.sh "$temporary/prepare-data.sh"
sh -n "$temporary/backup.sh"
sh -n "$temporary/prepare-data.sh"
# Two independent secrets: one signs sessions, one encrypts WebUntis passwords.
secret=$(openssl rand -hex 32)
key=$(openssl rand -hex 32)
[ "$secret" != "$key" ] || fail 'Secret generation failed. Nothing was created.'
printf '%s\n' \
  '# Created by install.sh. Keep both secrets unchanged across updates and restores.' \
  "BETTER_AUTH_SECRET=$secret" \
  "ENCRYPTION_KEY=$key" \
  '' \
  '# Exact browser URL; use your public https:// domain behind a reverse proxy.' \
  "PUBLIC_URL=$instance_url" \
  '' \
  '# Host port, listen address and instance name.' \
  '# Use 0.0.0.0 for LAN access. Keep the instance name unchanged after setup.' \
  "HOST_PORT=$host_port" \
  "BIND_ADDRESS=$bind_address" \
  "COMPOSE_PROJECT_NAME=$instance_name" \
  '' \
  '# Optional: pin a release instead of using latest.' \
  '# BRIDGE_IMAGE=ghcr.io/14flavius/webuntis-ics-bridge:1.0.0' \
  '' \
  '# Apply changes: docker compose up -d --pull never --wait' \
  > "$temporary/.env"
docker compose --env-file "$temporary/.env" -f "$temporary/docker-compose.yml" config --quiet

# Hard links fail if a concurrent installer created a destination in the meantime.
mkdir -p scripts
ln "$temporary/docker-compose.yml" docker-compose.yml
ln "$temporary/backup.sh" scripts/backup.sh
ln "$temporary/prepare-data.sh" scripts/prepare-data.sh
ln "$temporary/.env" .env

printf '%s\n' 'Configuration saved. Downloading and starting WebUntis ICS Bridge...'
sh scripts/prepare-data.sh
if ! docker compose up -d --wait --wait-timeout 180; then
  fail 'Startup failed. Configuration and any data were retained. Check docker compose logs --tail=100, then retry docker compose up -d --wait.'
fi
printf '\nOpen %s\n' "$instance_url"
printf '%s\n' \
  'Create your administrator within two hours; the first account becomes the administrator.' \
  'Restart: docker compose restart bridge' \
  'Backup: sh scripts/backup.sh' \
  'Update: sh scripts/backup.sh && docker compose pull && docker compose up -d --wait'
