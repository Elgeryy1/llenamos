#!/bin/sh
# Demuestra que la imagen de PRODUCCIÓN rechaza la identidad de ensayo. Uso: sh apps/api/scripts/rehearsal-reject-docker.sh llenamos-ensayo/api:ensayo
# Sin red ni base de datos: el proceso debe morir en la configuración, antes de abrir nada.
set -eu
image=${1:?uso: rehearsal-reject-docker.sh imagen-api}
dir=$(mktemp -d /tmp/llenamos-rehearsal-reject.XXXXXX)
trap 'rm -rf "$dir"' EXIT HUP INT TERM
printf 'postgresql://llenamos_api_login:x@db.invalid:5432/llenamos' > "$dir/database-url"
# Mismo formato que el del ensayo (hex de 24 bytes) y montado en la única ruta admitida.
printf 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56' > "$dir/secret"
chmod 444 "$dir/database-url" "$dir/secret"
run() { # $@ = variables -e adicionales
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=bind,src=$dir/database-url,dst=/run/database-url,readonly" --mount "type=bind,src=$dir/secret,dst=/run/secrets/rehearsal_identity_secret,readonly" \
    -e FIREBASE_PROJECT_ID=llenamos-logiqd -e DATABASE_URL_FILE=/run/database-url \
    -e REHEARSAL_IDENTITY_URL=http://identity:9102 -e REHEARSAL_IDENTITY_SECRET_FILE=/run/secrets/rehearsal_identity_secret "$@" "$image" node dist/main.js 2>&1
}
expect_rejected() { # $1 etiqueta; resto: opciones de docker run
  label=$1; shift
  if out=$(run "$@"); then echo "FALLO ($label): el proceso arrancó con la identidad de ensayo" >&2; exit 1; fi
  case "$out" in *'NODE_ENV=rehearsal'*) echo "ok: $label rechazada";; *) echo "FALLO ($label): salió, pero no por la regla de ensayo: $out" >&2; exit 1;; esac
}
expect_rejected 'imagen con su NODE_ENV por defecto (production)'
expect_rejected 'NODE_ENV=production explícito' -e NODE_ENV=production
expect_rejected 'NODE_ENV vacío' -e NODE_ENV=
expect_rejected 'NODE_ENV=development' -e NODE_ENV=development
expect_rejected 'NODE_ENV=Production (mayúscula)' -e NODE_ENV=Production
expect_rejected 'solo el secreto, sin la URL, en producción' -e REHEARSAL_IDENTITY_URL=
# Control: con NODE_ENV=rehearsal y el proyecto de ensayo (llenamos-ensayo) TODAS las reglas de configuración se superan y el
# proceso falla después, por la base de datos inexistente. Se comprueba el mensaje: no basta con «sale con error».
if out=$(run -e NODE_ENV=rehearsal -e FIREBASE_PROJECT_ID=llenamos-ensayo -e TRUSTED_IP_HEADER=x-real-ip -e TRUSTED_PROXY_ADDRESSES=172.30.43.3); then echo 'FALLO (control): arrancó sin base de datos' >&2; exit 1; fi
case "$out" in
  *'NODE_ENV=rehearsal'*|*'FIREBASE_PROJECT_ID'*|*'REHEARSAL_IDENTITY'*|*'TRUSTED_'*|*'-ensayo'*) echo "FALLO (control): rechazó el modo ensayo legítimo por la configuración: $out" >&2; exit 1;;
  *ENOTFOUND*|*EAI_AGAIN*|*ECONNREFUSED*|*getaddrinfo*|*'db.invalid'*) echo 'ok: con NODE_ENV=rehearsal y llenamos-ensayo la configuración se supera (falla más tarde, por la base de datos)';;
  *) echo "FALLO (control): falló por una causa inesperada: $out" >&2; exit 1;;
esac
echo 'La imagen de producción rechaza la identidad de ensayo.'
