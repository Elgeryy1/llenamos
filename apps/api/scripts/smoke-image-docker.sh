#!/bin/sh
# Imagen ya construida; red/DB/credenciales de fixture propias, sin servicios reales.
set -eu
image=${1:-llenamos-api:registry-test}
suffix="$$-$(date +%s)"
network="llenamos-api-smoke-$suffix"
edge="llenamos-api-smoke-edge-$suffix"
database="llenamos-api-smoke-db-$suffix"
api="llenamos-api-smoke-http-$suffix"
directory=$(mktemp -d /tmp/llenamos-api-smoke.XXXXXX)
network_owned=0
edge_owned=0
database_owned=0
api_owned=0
cleanup() {
  if test "$api_owned" = 1; then docker rm -f "$api" >/dev/null; fi
  if test "$database_owned" = 1; then docker rm -fv "$database" >/dev/null; fi
  if test "$edge_owned" = 1; then docker network rm "$edge" >/dev/null; fi
  if test "$network_owned" = 1; then docker network rm "$network" >/dev/null; fi
  rm -f "$directory/bootstrap-url" "$directory/runtime-url"
  rmdir "$directory"
}
trap cleanup EXIT HUP INT TERM
docker network create --internal "$network" >/dev/null
network_owned=1
docker network create "$edge" >/dev/null
edge_owned=1
docker run -d --name "$database" --network "$network" --label llenamos.test=api-image \
  --memory 512m --cpus 1 -e POSTGRES_DB=llenamos_api_test_image -e POSTGRES_PASSWORD=fixture-only-password \
  postgres:18.4-bookworm@sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382 >/dev/null
database_owned=1
ready=0
for attempt in $(seq 1 30); do
  if docker exec "$database" pg_isready -U postgres -d llenamos_api_test_image >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
printf 'postgresql://postgres:fixture-only-password@%s:5432/llenamos_api_test_image' "$database" > "$directory/bootstrap-url"
printf 'postgresql://llenamos_api_test:fixture-only-password@%s:5432/llenamos_api_test_image' "$database" > "$directory/runtime-url"
chmod 444 "$directory/bootstrap-url" "$directory/runtime-url"
# Migrar dos veces comprueba el ledger y el arranque compilado sin tsx/devDependencies.
for attempt in 1 2; do
  docker run --rm --network "$network" --read-only --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=bind,src=$directory/bootstrap-url,dst=/run/bootstrap-url,readonly" \
    -e MIGRATION_DATABASE_URL_FILE=/run/bootstrap-url "$image" node dist/migrate.js
done
docker exec "$database" psql -U postgres -d llenamos_api_test_image -v ON_ERROR_STOP=1 -c \
  "CREATE ROLE llenamos_api_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD 'fixture-only-password' IN ROLE llenamos_app" >/dev/null
docker run -d --name "$api" --network "$network" --network "$edge" --label llenamos.test=api-image \
  --read-only --cap-drop ALL --security-opt no-new-privileges --memory 256m --cpus 1 \
  --mount "type=bind,src=$directory/runtime-url,dst=/run/runtime-url,readonly" \
  -e DATABASE_URL_FILE=/run/runtime-url -e FIREBASE_PROJECT_ID=llenamos-logiqd \
  -p 127.0.0.1::3100 "$image" >/dev/null
api_owned=1
port=$(docker port "$api" 3100/tcp | sed -n 's/^127\.0\.0\.1://p')
if test -z "$port"; then docker logs "$api"; exit 1; fi
ready=0
for attempt in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:$port/readyz" >/dev/null; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1
test "$(curl --silent "http://127.0.0.1:$port/healthz")" = '{"status":"ok"}'
test "$(curl --silent -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/session")" = 401
test "$(curl --silent -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer invalid' "http://127.0.0.1:$port/v1/session")" = 401
docker exec "$api" node --input-type=module -e 'import {readFileSync} from "node:fs";if(process.getuid()===0)process.exit(1);const code=readFileSync("dist/main.js","utf8");if(/from ["\x27](?:firebase\/(?:firestore|functions|storage)|firebase-admin\/(?:firestore|database|storage|functions))["\x27]/.test(code))process.exit(1);for(const p of ["firebase/firestore","firebase/functions","firebase/storage"]){try{import.meta.resolve(p);process.exit(1)}catch{}}'
echo 'Imagen API: migración repetible, health/readiness, Bearer fail-closed y usuario no root correctos.'
