#!/usr/bin/env bash
# Deploy the platform (API + console + MongoDB) on this Linux server with Docker Compose.
#
#   ./deploy.sh              build images and (re)start the stack, then health-check it
#   ./deploy.sh status       show containers and health
#   ./deploy.sh logs [svc]   follow logs (api, web or mongo)
#   ./deploy.sh backup       dump the database to ./backups/
#   ./deploy.sh restore F    restore a dump made by `backup` (asks first)
#   ./deploy.sh down         stop the stack (data volumes are kept)
#
# Settings come from .env.production (see .env.production.example).
set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE=.env.production
COMPOSE_FILE=docker-compose.prod.yml
BACKUP_DIR=backups

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# Value of KEY in the env file (last assignment wins, surrounding quotes stripped).
env_value() {
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)
  line=${line#*=}
  line=${line%\"}; line=${line#\"}; line=${line%\'}; line=${line#\'}
  printf '%s' "$line"
}

preflight() {
  command -v docker >/dev/null || die "Docker is not installed."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is not available (docker compose)."
  docker info >/dev/null 2>&1 || die "Can't reach the Docker daemon (is it running, and may this user use it?)."
  [[ -f $ENV_FILE ]] || die "$ENV_FILE is missing: cp .env.production.example $ENV_FILE, then fill it in."

  local perms
  perms=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo "")
  if [[ -n $perms && $perms != 600 && $perms != 400 ]]; then
    warn "$ENV_FILE is mode $perms; it holds secrets, consider: chmod 600 $ENV_FILE"
  fi

  local missing=()
  for key in DOMAIN MONGO_ROOT_USER MONGO_ROOT_PASSWORD JWT_SECRET PLATFORM_SECRET_KEY; do
    [[ -n $(env_value "$key") ]] || missing+=("$key")
  done
  (( ${#missing[@]} == 0 )) || die "Set these in $ENV_FILE: ${missing[*]}"

  [[ $(env_value DOMAIN) != agents.example.com ]] || die "DOMAIN is still the example value."
  (( $(env_value JWT_SECRET | wc -c) > 32 )) || die "JWT_SECRET is too short; use: openssl rand -base64 48"
  [[ $(env_value MONGO_ROOT_USER) =~ ^[A-Za-z0-9_-]+$ ]] || die "MONGO_ROOT_USER may use only letters, digits, - and _."
  [[ $(env_value MONGO_ROOT_PASSWORD) =~ ^[A-Za-z0-9_-]{16,}$ ]] \
    || die "MONGO_ROOT_PASSWORD needs 16+ characters of letters, digits, - and _ (it goes into a URI); use: openssl rand -hex 24"
  if [[ $(env_value MCP_ALLOW_INSECURE_LOCAL) =~ ^(1|true|yes)$ ]]; then
    warn "MCP_ALLOW_INSECURE_LOCAL is set; production ignores it."
  fi
}

wait_healthy() {
  local service=$1 timeout=${2:-180} waited=0 id state
  id=$(compose ps -q "$service")
  [[ -n $id ]] || die "$service did not start; see: ./deploy.sh logs $service"
  while :; do
    state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")
    case $state in
      healthy|running) return 0 ;;
      unhealthy|exited|dead) compose logs --tail 50 "$service" >&2; die "$service is $state." ;;
    esac
    (( waited >= timeout )) && { compose logs --tail 50 "$service" >&2; die "$service not healthy after ${timeout}s."; }
    sleep 3; waited=$((waited + 3))
  done
}

cmd_up() {
  preflight
  local tag
  tag=${IMAGE_TAG:-$(env_value IMAGE_TAG)}
  if [[ -z $tag ]]; then
    if tag=$(git rev-parse --short HEAD 2>/dev/null); then
      git diff --quiet HEAD || tag="$tag-dirty"
    else
      tag=$(date +%Y%m%d%H%M%S)
    fi
  fi
  export IMAGE_TAG=$tag

  log "Building images ($tag)"
  DOCKER_BUILDKIT=1 compose build --pull

  log "Starting the stack"
  compose up -d --remove-orphans

  log "Waiting for health checks"
  wait_healthy mongo
  wait_healthy api
  wait_healthy web 60

  local domain
  domain=$(env_value DOMAIN)
  if [[ $domain == :* ]]; then
    curl -fsS "http://127.0.0.1${domain}/api/health" >/dev/null \
      && log "Through the proxy: /api/health ok" || warn "/api/health via the proxy failed"
  else
    curl -fsS --max-time 20 "https://${domain}/api/health" >/dev/null \
      && log "Live at https://${domain}" \
      || warn "https://${domain}/api/health didn't answer yet (DNS or the certificate may still be pending): ./deploy.sh logs web"
  fi

  docker image prune -f --filter "until=168h" >/dev/null || true
  compose ps
}

cmd_backup() {
  [[ -f $ENV_FILE ]] || die "$ENV_FILE is missing."
  mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
  local file
  file="$BACKUP_DIR/mongo-$(date +%Y%m%d-%H%M%S).archive.gz"
  log "Dumping the database to $file"
  compose exec -T mongo sh -c \
    'mongodump --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip' \
    > "$file"
  log "Done ($(du -h "$file" | cut -f1))"
}

cmd_restore() {
  local file=${1:-}
  [[ -f $file ]] || die "Usage: ./deploy.sh restore <dump.archive.gz>"
  warn "This replaces the collections in the dump with its contents (--drop)."
  read -r -p "Type 'restore' to continue: " answer
  [[ $answer == restore ]] || die "Cancelled."
  compose exec -T mongo sh -c \
    'mongorestore --quiet --drop --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip' \
    < "$file"
  log "Restored from $file"
}

case ${1:-up} in
  up|deploy) cmd_up ;;
  status)    compose ps ;;
  logs)      shift; compose logs -f --tail 200 "$@" ;;
  backup)    cmd_backup ;;
  restore)   shift; cmd_restore "$@" ;;
  down)      compose down ;;
  -h|--help|help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "Unknown command: $1 (see ./deploy.sh help)" ;;
esac
