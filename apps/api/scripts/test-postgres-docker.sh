#!/bin/sh
# Solo una DB temporal de pruebas. No usa servicios o volúmenes de producción.
set -eu
cd "$(dirname "$0")/.."
name="llenamos-api-test-$$-$(date +%s)"
owned=0
cleanup() { if test "$owned" = 1; then docker rm -fv "$name" >/dev/null; fi; }
trap cleanup EXIT HUP INT TERM
docker run -d --name "$name" --label llenamos.test=api-foundation --memory 512m --cpus 1 \
  -e POSTGRES_DB=llenamos_api_test_foundation -e POSTGRES_PASSWORD=fixture-only-password \
  -p 127.0.0.1::5432 \
  postgres:18.4-bookworm@sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382 >/dev/null
owned=1
ready=0
for attempt in $(seq 1 30); do
  if docker exec "$name" pg_isready -U postgres -d llenamos_api_test_foundation >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if test "$ready" != 1; then echo 'PostgreSQL de pruebas no está preparado.' >&2; exit 1; fi
port=$(docker port "$name" 5432/tcp | sed -n 's/^127\.0\.0\.1://p')
TEST_POSTGRES_API=1 TEST_POSTGRES_URL="postgresql://postgres:fixture-only-password@127.0.0.1:$port/llenamos_api_test_foundation" pnpm test "$@"
