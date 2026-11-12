#!/bin/sh
# Da de alta (o renueva) operadores de plataforma de LogiQD. Ejecutar en /srv/llenamos con la aplicación levantada:
#   sh operador.sh admin@logiqd.me dani@logiqd.me ...
# Por cada correo: cuenta en Firebase Auth con los claims logiqd y sessionVersion, y fila en llenamos.identities con
# platform_operator=true y la misma versión. La contraseña la fija cada persona con el correo de restablecimiento.
set -eu
cd "$(dirname "$0")"
test "$#" -gt 0 || { echo 'Uso: sh operador.sh correo@logiqd.me [...]' >&2; exit 2; }
. ./compose-set.sh
VPS_ENV_FILES=.env
api_image=$(sed -n 's/^API_IMAGE=//p' .env)
credential=$(sed -n 's/^FIREBASE_AUTH_ADMIN_FILE=//p' .env); credential=${credential:-./secrets/firebase_auth_admin.json}
credential=$(cd "$(dirname "$credential")" && printf '%s/%s' "$(pwd)" "$(basename "$credential")")
for email in "$@"; do
  out=$(docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    -v "$(pwd)/operador.mjs:/app/operador.mjs:ro" -v "$credential:/run/secrets/firebase_auth_admin:ro" \
    "$api_image" node operador.mjs "$email")
  uid=${out% *}; version=${out#* }
  printf '%s' "$uid" | grep -Eq '^[A-Za-z0-9_-]{1,128}$' || { echo "uid no válido para $email" >&2; exit 1; }
  printf '%s' "$version" | grep -Eq '^[a-f0-9]{32}$' || { echo "versión no válida para $email" >&2; exit 1; }
  vps_compose 'exec -T postgres psql -U llenamos_bootstrap -d llenamos -X -q -At -v ON_ERROR_STOP=1' <<SQL
INSERT INTO llenamos.identities(uid, session_version, tokens_valid_after, locked, disabled, platform_operator)
VALUES('$uid', '$version', now() - interval '1 minute', false, false, true)
ON CONFLICT(uid) DO UPDATE SET session_version = excluded.session_version, locked = false, disabled = false, platform_operator = true;
SQL
  echo "operador listo: $email"
done
