#!/bin/sh
# Ejecutar en /srv/llenamos con una release.env generada por CI. No descarga código ni compila.
set -eu
cd "$(dirname "$0")"
release=${1:?Uso: sh release.sh /ruta/release.env}
test -f "$release"
test -f .env
# Freno de emergencia: con 1 no se ejecuta nada de lo de abajo. Desbloqueada el 2026-11-12 al integrar la aceptación VPS.
RELEASE_BLOCKED=0
if test "$RELEASE_BLOCKED" = 1; then
  echo 'Despliegue detenido: completar y validar la migración VPS (Firebase solo Auth).' >&2
  exit 1
fi
# Al VPS solo se copian release.sh, base-de-datos.sh, scram.mjs, operador.sh, operador.mjs, check-no-rehearsal.sh, compose-set.sh y compose*.yaml
# (ver README); ./ensayo no se copia.
if test -d ./ensayo; then
  echo 'ERROR: deploy/vps/ensayo no debe estar presente en el entorno de producción.' >&2
  exit 1
fi
# Compose lee el fichero; nunca ejecutar su contenido mediante source/eval.
check_ref() { # $1 clave, $2 expresión del repositorio
  # Exactamente una línea por clave: con dos, compose usaría la última aunque la guardia viera la buena.
  test "$(grep -c "^$1=" "$release")" = 1 || { echo "Referencia inmutable no válida: $1 debe aparecer exactamente una vez" >&2; exit 1; }
  value=$(sed -n "s/^$1=//p" "$release")
  if ! printf '%s\n' "$value" | grep -Eq "^ghcr.io/logiqd/llenamos-($2)@sha256:[0-9a-f]{64}\$"; then
    echo "Referencia inmutable no válida: $1" >&2; exit 1
  fi
}
check_ref WEB_IMAGE web
check_ref GATEWAY_IMAGE gateway
check_ref API_IMAGE api
check_ref BACKUP_IMAGE backup
# Conservar la configuración de túnel/secretos de .env al actualizar solo las imágenes.
sed '/^WEB_IMAGE=/d; /^GATEWAY_IMAGE=/d; /^API_IMAGE=/d; /^BACKUP_IMAGE=/d' .env > .env.candidate
for key in WEB_IMAGE GATEWAY_IMAGE API_IMAGE BACKUP_IMAGE; do sed -n "/^${key}=/p" "$release" >> .env.candidate; done
chmod 600 .env.candidate
trap 'rm -f .env.candidate' EXIT
# La guardia valida el MISMO conjunto de compose y el entorno candidato que se va a desplegar, ANTES de tocar nada.
REQUIRE_DOCKER=1 sh ./check-no-rehearsal.sh "$release" .env .env.candidate
. ./compose-set.sh
services='postgres api worker web gateway'
VPS_ENV_FILES='.env.candidate'
vps_compose 'config --quiet'
# shellcheck disable=SC2086
vps_compose "pull $services"
# Migraciones (compatibles con la versión anterior) y logins con la imagen API nueva, antes de recrear la aplicación.
sh ./base-de-datos.sh .env.candidate
# Mantener referencia y configuración anteriores antes de recrear contenedores.
cp .env .env.previous
healthy() { # $1 fichero de entorno con el que se levanta
  VPS_ENV_FILES=$1
  # shellcheck disable=SC2086
  vps_compose "up -d --wait --wait-timeout 120 $services" || return 1
  for service in $services; do
    cid=$(vps_compose "ps -q $service" 2>/dev/null || true)
    test -n "$cid" || return 1
    vars=$(docker inspect "$cid" --format '{{json .Config.Env}}' 2>/dev/null || true)
    if printf '%s' "$vars" | grep -Eiq 'REHEARSAL_|NODE_ENV=rehearsal|llenamos-ensayo'; then
      echo "ERROR: el contenedor $service contiene configuración o imagen de ensayo." >&2; return 1
    fi
  done
}
if healthy .env.candidate; then
  mv .env.candidate .env
  echo 'Servicios saludables en loopback. Verificar Firebase y proveedores antes de publicar el túnel.'
else
  echo 'La release no está saludable; se vuelve a la anterior.' >&2
  # Mismo conjunto de servicios (incluidos api y worker) con las imágenes anteriores.
  healthy .env.previous || echo 'ATENCIÓN: tampoco la versión anterior queda saludable; intervención manual.' >&2
  exit 1
fi
