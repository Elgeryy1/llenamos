#!/bin/sh
# Prepara la base de datos de producción en /srv/llenamos. Idempotente: sirve para la primera instalación y para cada release.
#   sh base-de-datos.sh [fichero de entorno]   (por defecto .env; release.sh lo llama con .env.candidate)
# 1) levanta solo PostgreSQL; 2) aplica las migraciones con el rol bootstrap y la imagen API del entorno;
# 3) crea o actualiza los cuatro logins sin privilegios (solo viaja el verificador SCRAM, nunca la contraseña);
# 4) deja apagada la marca de ensayo y lo comprueba.
# Las migraciones deben ser compatibles con la versión anterior: si la release falla, release.sh vuelve a las imágenes
# anteriores sobre la base ya migrada.
set -eu
cd "$(dirname "$0")"
if test -d ./ensayo; then echo 'ERROR: deploy/vps/ensayo no debe estar presente en el entorno de producción.' >&2; exit 1; fi
VPS_ENV_FILES=${1:-.env}
test -f "$VPS_ENV_FILES"
. ./compose-set.sh
api_image=$(sed -n 's/^API_IMAGE=//p' "$VPS_ENV_FILES")
test -n "$api_image" || { echo 'Falta API_IMAGE en el entorno.' >&2; exit 1; }
secret() { # $1 nombre; respeta la ruta *_FILE del entorno si existe
  key=$(printf '%s_FILE' "$1" | tr a-z A-Z)
  path=$(sed -n "s/^$key=//p" "$VPS_ENV_FILES")
  path=${path:-./secrets/$1}
  test -s "$path" || { echo "Falta el secreto $1 ($path)." >&2; exit 1; }
  (cd "$(dirname "$path")" && printf '%s/%s' "$(pwd)" "$(basename "$path")")
}

for s in bootstrap_database_url pw_api pw_worker pw_webhook pw_backup; do secret "$s" > /dev/null; done
vps_compose 'up -d --wait --wait-timeout 120 postgres'
cid=$(vps_compose 'ps -q postgres')
net=$(docker inspect "$cid" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')
hardening='--rm --read-only --cap-drop ALL --security-opt no-new-privileges:true'

# shellcheck disable=SC2086
docker run $hardening --network "$net" -e MIGRATION_DATABASE_URL_FILE=/run/secrets/bootstrap_database_url \
  -v "$(secret bootstrap_database_url):/run/secrets/bootstrap_database_url:ro" "$api_image" node dist/migrate.js

# shellcheck disable=SC2086
verifier() { tr -d '\n' < "$(secret "pw_$1")" | docker run $hardening -i --network none -v "$(pwd)/scram.mjs:/tmp/scram.mjs:ro" "$api_image" node /tmp/scram.mjs; }
api_v=$(verifier api); worker_v=$(verifier worker); webhook_v=$(verifier webhook); backup_v=$(verifier backup)
psql_boot() { vps_compose 'exec -T postgres psql -U llenamos_bootstrap -d llenamos -X -q -At -v ON_ERROR_STOP=1'; }
psql_boot <<SQL
DO \$\$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('llenamos_api_login', '$api_v', 'NOBYPASSRLS', 'llenamos_app'),
    ('llenamos_worker_login', '$worker_v', 'NOBYPASSRLS', 'llenamos_app, llenamos_worker'),
    ('llenamos_webhook_login', '$webhook_v', 'NOBYPASSRLS', 'llenamos_webhook'),
    ('llenamos_backup_login', '$backup_v', 'BYPASSRLS', 'pg_read_all_data')) AS t(name, verifier, rls, roles)
  LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname = r.name) THEN
      EXECUTE format('ALTER ROLE %I PASSWORD %L', r.name, r.verifier);
    ELSE
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE %s PASSWORD %L IN ROLE %s', r.name, r.rls, r.verifier, r.roles);
    END IF;
  END LOOP;
  UPDATE llenamos.platform_flags SET enabled = false WHERE name = 'rehearsal';
END \$\$;
SQL
flag=$(echo "SELECT coalesce((SELECT enabled::text FROM llenamos.platform_flags WHERE name = 'rehearsal'), 'falta')" | psql_boot)
test "$flag" = false || { echo "ERROR: la marca de ensayo no queda apagada ($flag)." >&2; exit 1; }
echo 'Base de datos migrada, logins al día y ensayo apagado.'
