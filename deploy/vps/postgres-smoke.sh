#!/bin/sh
# Solo contenedores y volumen temporales del proyecto de prueba; nunca servicios vivos.
set -eu
cd "$(dirname "$0")"
project="llenamos-pg-smoke-$$"
scratch=$(mktemp -d /tmp/llenamos-pg-smoke.XXXXXX)
export POSTGRES_BOOTSTRAP_PASSWORD_FILE="$scratch/password"
umask 077
openssl rand -hex 32 > "$POSTGRES_BOOTSTRAP_PASSWORD_FILE"
dc() { docker compose -p "$project" -f compose.postgres.yaml --profile vps-backend "$@"; }
cleanup() {
  dc down --volumes >/dev/null 2>&1 || true
  rm -f "$POSTGRES_BOOTSTRAP_PASSWORD_FILE"
  rmdir "$scratch"
}
trap cleanup EXIT
dc config --quiet
dc up -d --wait --wait-timeout 120
dc exec -T postgres psql -U llenamos_bootstrap -d llenamos -v ON_ERROR_STOP=1 -c 'CREATE TABLE smoke (value integer NOT NULL); INSERT INTO smoke VALUES (42);' >/dev/null
dc restart postgres >/dev/null
dc up -d --wait --wait-timeout 60 >/dev/null
result=$(dc exec -T postgres psql -U llenamos_bootstrap -d llenamos -Atqc 'SELECT value FROM smoke')
test "$result" = 42
container=$(dc ps -q postgres)
ports=$(docker inspect "$container" --format '{{json .NetworkSettings.Ports}}')
test "$ports" = '{"5432/tcp":null}'
dc exec -T postgres psql -U llenamos_bootstrap -d llenamos -Atqc 'SHOW data_directory; SHOW max_connections; SHOW shared_buffers;'
echo 'PASS: PostgreSQL18 arranca, conserva datos al reiniciar y no publica su puerto.'
