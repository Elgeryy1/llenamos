#!/bin/sh
# Guardia de release: la identidad de ensayo (REHEARSAL_*, NODE_ENV=rehearsal, compose.ensayo.yaml) debe estar APAGADA.
# Uso: sh check-no-rehearsal.sh <fichero.env>...   El texto de TODOS se revisa; el render usa solo el ÚLTIMO, que es el que se despliega
#   (release.sh pasa «release.env .env .env.candidate» y despliega con .env.candidate).
#   REQUIRE_DOCKER=1  falla si no hay docker (lo exige release.sh). Sin docker y sin esa variable también falla,
#                     salvo ALLOW_NO_DOCKER=1, que solo permite la revisión de texto y avisa de que NO se validó el render.
# 1) Texto de cada .env y del entorno del proceso; 2) render del MISMO conjunto de compose que se despliega, validado en
# positivo (servicios exactos, imágenes por digest, NODE_ENV=production, nada de ensayo).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
test "$#" -ge 1 || { echo 'Uso: check-no-rehearsal.sh fichero.env...' >&2; exit 2; }
bad=0
fail() { echo "$1" >&2; bad=1; }
# Variables de compose que cambian QUÉ se despliega: prohibidas en cualquier .env y en el entorno.
forbidden_compose='COMPOSE_FILE|COMPOSE_PROFILES|COMPOSE_PROJECT_NAME|COMPOSE_PATH_SEPARATOR|COMPOSE_ENV_FILES'

last_env=''
for envfile in "$@"; do
  test -f "$envfile" || { echo "No existe $envfile" >&2; exit 2; }
  last_env=$envfile
  # Admite «export CLAVE=valor», «CLAVE: valor», comillas simples/dobles y espacios; ignora comentarios.
  offending=$(awk -v forbidden="^($forbidden_compose)$" '
    /^[[:space:]]*(#|$)/ { next }
    {
      line = $0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      cut = match(line, /[=:]/)
      if (cut == 0) next
      key = substr(line, 1, cut - 1); value = substr(line, cut + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^["\x27]|["\x27]$/, "", value)
      if (key ~ /^(REHEARSAL_|ENSAYO_)/ || tolower(key) ~ /rehearsal|ensayo/) { print NR ": clave de ensayo " key; next }
      if (key ~ forbidden) { print NR ": " key " cambia los ficheros o el proyecto de compose"; next }
      if (key == "NODE_ENV" && value != "production") { print NR ": NODE_ENV distinto de production"; next }
      if (key ~ /_IMAGE$/ && seen[key]++) { print NR ": " key " aparece más de una vez (compose usaría la última)"; next }
      if (tolower(value) ~ /rehearsal|ensayo/) { print NR ": el valor de " key " menciona el ensayo" }
    }' "$envfile")
  if [ -n "$offending" ]; then
    fail "Identidad, imagen o configuración de ensayo en $envfile (no se publica):
$offending"
  fi
done

# Entorno del proceso: tiene precedencia sobre los .env, así que también cuenta.
leaked=$(env | awk -F= -v forbidden="^($forbidden_compose)$" '$1 ~ /^(REHEARSAL_|ENSAYO_)/ || $1 ~ forbidden || $1 ~ /_IMAGE$/ || ($1 == "NODE_ENV" && $2 ~ /rehearsal/) { print $1 }')
test -z "$leaked" || fail "Variables prohibidas en el entorno del proceso (anulan al .env): $(echo "$leaked" | tr '\n' ' ')"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  if [ "${REQUIRE_DOCKER:-}" != 1 ] && [ "${ALLOW_NO_DOCKER:-}" = 1 ]; then
    echo 'AVISO: sin docker; solo se revisó el texto. La configuración de compose NO se ha validado.' >&2
  else
    fail 'Falta docker compose: no se puede validar la configuración que se desplegaría (REQUIRE_DOCKER).'
  fi
else
  VPS_COMPOSE_DIR=$here
  VPS_ENV_FILES=$last_env
  # shellcheck source=compose-set.sh
  . "$here/compose-set.sh"
  if ! rendered=$(vps_compose 'config --format json' 2>&1); then
    fail "Error validando docker compose config con los entornos proporcionados:
$rendered"
  elif ! command -v jq >/dev/null 2>&1; then
    fail 'Falta jq: no se puede validar en positivo la configuración renderizada.'
  else
    expected='["api","backup","gateway","ledger","postgres","tunnel","web","worker"]'
    # Repositorio exacto de cada servicio: una imagen de otro repositorio, aunque lleve digest, no se despliega.
    repos='{"web":"ghcr\\.io/logiqd/llenamos-web","gateway":"ghcr\\.io/logiqd/llenamos-gateway","api":"ghcr\\.io/logiqd/llenamos-api","worker":"ghcr\\.io/logiqd/llenamos-api","backup":"ghcr\\.io/logiqd/llenamos-backup","ledger":"ghcr\\.io/logiqd/llenamos-backup","postgres":"postgres:18\\.4-bookworm","tunnel":"cloudflare/cloudflared"}'
    problems=$(printf '%s' "$rendered" | jq -r --argjson expected "$expected" --argjson repos "$repos" '
      [ (if .name != "llenamos" then "proyecto de compose distinto de llenamos: \(.name)" else empty end),
        (if (.services | keys) != $expected then "servicios distintos de los esperados: \(.services | keys | join(","))" else empty end),
        (.services | to_entries[] | . as $e | ($repos[$e.key] // null) as $repo
          | if $repo == null then "servicio sin repositorio de imagen esperado: \($e.key)"
            elif ($e.value.image | test("^" + $repo + "@sha256:[0-9a-f]{64}$") | not) then "imagen de \($e.key) fuera de \($repo) o sin digest: \($e.value.image)"
            else empty end),
        (.services | to_entries[] | select(.value.image | test("ensayo|rehearsal"; "i")) | "imagen de ensayo en \(.key)"),
        (["api","worker","web"][] as $s | select(.services[$s].environment.NODE_ENV != "production") | "NODE_ENV de \($s) no es production"),
        (if (tostring | test("rehearsal|ensayo"; "i")) then "la configuración renderizada menciona el ensayo" else empty end)
      ] | .[]' 2>&1) || fail "No se pudo interpretar la configuración renderizada: $problems"
    test -z "$problems" || fail "Configuración de compose no válida para producción:
$problems"
  fi
fi

test "$bad" = 0 || exit 1
echo 'Identidad de ensayo apagada.'
