#!/bin/sh
# Prueba de la guardia de release con ficheros de ejemplo (no usa imágenes ni red; `docker compose config` no descarga nada).
# Cada caso sucio debe fallar Y por la razón esperada (se comprueba el mensaje), no por un error cualquiera.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT HUP INT TERM
digest=0000000000000000000000000000000000000000000000000000000000000000
cat > "$tmp/limpio.env" <<ENV
WEB_IMAGE=ghcr.io/logiqd/llenamos-web@sha256:$digest
GATEWAY_IMAGE=ghcr.io/logiqd/llenamos-gateway@sha256:$digest
API_IMAGE=ghcr.io/logiqd/llenamos-api@sha256:$digest
BACKUP_IMAGE=ghcr.io/logiqd/llenamos-backup@sha256:$digest
TUNNEL_IMAGE=cloudflare/cloudflared@sha256:$digest
PUBLIC_APP_URL=https://app-llenamos.logiqd.me
BACKUP_UPLOAD_CMD=true
PLATFORM_EMAIL_FROM=avisos@logiqd.me
# comentario con ensayo y rehearsal: no cuenta
ENV
out="$tmp/salida"
REQUIRE_DOCKER=1 sh "$here/check-no-rehearsal.sh" "$tmp/limpio.env" >"$out" 2>&1 || { cat "$out" >&2; echo 'FALLO: un entorno limpio fue rechazado' >&2; exit 1; }
grep -q 'Identidad de ensayo apagada' "$out"

# $1 etiqueta, $2 mensaje esperado (regex), el resto: líneas añadidas al .env limpio
expect_rejected() {
  label=$1; message=$2; shift 2
  cp "$tmp/limpio.env" "$tmp/sucio.env"; for line in "$@"; do printf '%s\n' "$line" >> "$tmp/sucio.env"; done
  if REQUIRE_DOCKER=1 sh "$here/check-no-rehearsal.sh" "$tmp/sucio.env" >"$out" 2>&1; then echo "FALLO: no detectó «$label»" >&2; exit 1; fi
  grep -Eq "$message" "$out" || { echo "FALLO: «$label» se rechazó, pero no por la razón esperada ($message):" >&2; cat "$out" >&2; exit 1; }
}
expect_rejected 'REHEARSAL_IDENTITY_URL'            'clave de ensayo REHEARSAL_IDENTITY_URL' 'REHEARSAL_IDENTITY_URL=http://identity:9102'
expect_rejected 'export REHEARSAL_*'                'clave de ensayo REHEARSAL_IDENTITY_SECRET_FILE' 'export REHEARSAL_IDENTITY_SECRET_FILE=/run/s'
expect_rejected 'REHEARSAL_ con sintaxis clave: valor' 'clave de ensayo REHEARSAL_X' 'REHEARSAL_X: 1'
expect_rejected 'ENSAYO_*'                          'clave de ensayo ENSAYO_EXTERNO_DIR' 'ENSAYO_EXTERNO_DIR=/tmp/x'
expect_rejected 'export ENSAYO_* con sangría'       'clave de ensayo ENSAYO_X' '   export ENSAYO_X=1'
expect_rejected 'NODE_ENV=rehearsal'                'NODE_ENV distinto de production' 'NODE_ENV=rehearsal'
expect_rejected "NODE_ENV='rehearsal'"              'NODE_ENV distinto de production' "NODE_ENV='rehearsal'"
expect_rejected 'NODE_ENV="rehearsal"'              'NODE_ENV distinto de production' 'NODE_ENV="rehearsal"'
expect_rejected 'export NODE_ENV=rehearsal'         'NODE_ENV distinto de production' 'export NODE_ENV=rehearsal'
expect_rejected 'NODE_ENV: rehearsal'               'NODE_ENV distinto de production' 'NODE_ENV: rehearsal'
expect_rejected 'NODE_ENV=development'              'NODE_ENV distinto de production' 'NODE_ENV=development'
expect_rejected 'imagen de ensayo en el valor'      'menciona el ensayo' 'WEB_IMAGE=llenamos-ensayo/web:ensayo'
expect_rejected 'COMPOSE_FILE con override'         'COMPOSE_FILE cambia los ficheros' 'COMPOSE_FILE=compose.yaml:ensayo/compose.ensayo.yaml'
expect_rejected 'COMPOSE_FILE con override renombrado' 'COMPOSE_FILE cambia los ficheros' 'COMPOSE_FILE=compose.yaml:extra/otro.yaml'
expect_rejected 'export COMPOSE_FILE'               'COMPOSE_FILE cambia los ficheros' 'export COMPOSE_FILE=compose.yaml:x.yaml'
expect_rejected 'COMPOSE_FILE: valor'               'COMPOSE_FILE cambia los ficheros' 'COMPOSE_FILE: compose.yaml:x.yaml'
expect_rejected 'COMPOSE_PROFILES'                  'COMPOSE_PROFILES cambia' 'COMPOSE_PROFILES=ensayo'
expect_rejected 'COMPOSE_PROJECT_NAME'              'COMPOSE_PROJECT_NAME cambia' 'COMPOSE_PROJECT_NAME=otro'
# Imagen sin digest: la validación en positivo del render la rechaza aunque el texto no mencione el ensayo.
expect_rejected 'imagen web sin digest'             'imagen de web fuera de .* o sin digest' 'WEB_IMAGE=ghcr.io/logiqd/llenamos-web:latest'

# Entorno del proceso: tiene precedencia sobre el .env.
for assignment in COMPOSE_FILE=compose.yaml:x.yaml COMPOSE_PROFILES=ensayo COMPOSE_PROJECT_NAME=otro NODE_ENV=rehearsal REHEARSAL_IDENTITY_URL=http://identity:9102 ENSAYO_X=1; do
  if env "$assignment" REQUIRE_DOCKER=1 sh "$here/check-no-rehearsal.sh" "$tmp/limpio.env" >"$out" 2>&1; then echo "FALLO: no detectó $assignment en el entorno" >&2; exit 1; fi
  grep -Eq 'Variables prohibidas en el entorno' "$out" || { echo "FALLO: $assignment sin el mensaje esperado:" >&2; cat "$out" >&2; exit 1; }
done
# Una variable de imagen en el entorno anula al .env: el render la delata aunque el texto del .env esté limpio.
if env WEB_IMAGE=llenamos-ensayo/web:ensayo REQUIRE_DOCKER=1 sh "$here/check-no-rehearsal.sh" "$tmp/limpio.env" >"$out" 2>&1; then echo 'FALLO: imagen de ensayo en el entorno' >&2; exit 1; fi
grep -Eq 'imagen de ensayo en web' "$out"

# Imagen con digest pero de un repositorio ajeno, y *_IMAGE duplicada o en el entorno: no se despliega imagen de otro repositorio.
expect_rejected 'imagen api de otro repositorio'    'imagen de api fuera de' "API_IMAGE=ghcr.io/atacante/api@sha256:$digest"
expect_rejected 'API_IMAGE duplicada (la última gana)' 'API_IMAGE aparece más de una vez' "API_IMAGE=ghcr.io/atacante/api@sha256:$digest"
expect_rejected 'tunnel de otro repositorio'        'imagen de tunnel fuera de' "TUNNEL_IMAGE=evil/cloudflared@sha256:$digest"
if env API_IMAGE="ghcr.io/atacante/api@sha256:$digest" REQUIRE_DOCKER=1 sh "$here/check-no-rehearsal.sh" "$tmp/limpio.env" >"$out" 2>&1; then echo 'FALLO: API_IMAGE en el entorno' >&2; exit 1; fi
grep -q 'Variables prohibidas en el entorno.*API_IMAGE' "$out"
# Solo el último fichero se renderiza (es el que se despliega); el texto de todos se revisa.
cp "$tmp/limpio.env" "$tmp/otro.env"; echo "WEB_IMAGE=ghcr.io/atacante/web@sha256:$digest" > "$tmp/viejo.env"
REQUIRE_DOCKER=1 sh "$here/check-no-rehearsal.sh" "$tmp/viejo.env" "$tmp/limpio.env" >/dev/null 2>&1 || { echo 'FALLO: el render debía usar solo el último fichero' >&2; exit 1; }

# Sin docker la guardia falla (no se salta el render); ALLOW_NO_DOCKER solo permite la revisión de texto y avisa; REQUIRE_DOCKER manda.
# Docker falso que sale con 1 (portable: no depende de enlaces ni de recortar el PATH).
nodocker="$tmp/bin"; mkdir "$nodocker"; printf '#!/bin/sh\nexit 1\n' > "$nodocker/docker"; chmod +x "$nodocker/docker"
if PATH="$nodocker:$PATH" sh "$here/check-no-rehearsal.sh" "$tmp/limpio.env" >"$out" 2>&1; then echo 'FALLO: pasó sin docker' >&2; exit 1; fi
grep -q 'Falta docker compose' "$out"
PATH="$nodocker:$PATH" ALLOW_NO_DOCKER=1 sh "$here/check-no-rehearsal.sh" "$tmp/limpio.env" >"$out" 2>&1
grep -q 'NO se ha validado' "$out"
if PATH="$nodocker:$PATH" ALLOW_NO_DOCKER=1 REQUIRE_DOCKER=1 sh "$here/check-no-rehearsal.sh" "$tmp/limpio.env" >"$out" 2>&1; then echo 'FALLO: REQUIRE_DOCKER no manda sobre ALLOW_NO_DOCKER' >&2; exit 1; fi
echo 'ok: la guardia acepta el entorno limpio y rechaza cada variante de la identidad de ensayo, con su motivo'
