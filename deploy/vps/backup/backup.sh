#!/bin/sh
# Copia cifrada de PostgreSQL y del volumen de archivos, enviada fuera del VPS.
# Se ejecuta en la imagen de backup (cliente PostgreSQL, openssl, tar, rsync/ssh) como el mismo uid que la API.
#
# Variables:
#   PGURI_FILE          URI SIN contraseña de un rol de copia (lectura de todo el esquema, con BYPASSRLS)
#   PGPASS_FILE         fichero "host:puerto:base:usuario:contraseña" (secreto); se copia a un .pgpass 0600
#   FILES_ROOT          volumen de archivos privados (solo lectura)
#   BACKUP_KEY_FILE     clave de custodia (64 hex). Distinta de la clave de integraciones y NUNCA junto a las copias
#   BACKUP_DIR          carpeta local de trabajo y retención corta
#   BACKUP_UPLOAD_CMD   orden que sube "$BACKUP_FILE" fuera del VPS (rsync, rclone…). Obligatoria, salvo ALLOW_LOCAL_ONLY=1
#   BACKUP_RETENTION_DAYS  días que se guardan en local (7 por defecto)
set -eu
umask 077
here=$(dirname "$0")
. "$here/lib.sh"
: "${PGURI_FILE:?}" "${FILES_ROOT:?}" "${BACKUP_KEY_FILE:?}" "${BACKUP_DIR:?}"
check_key "$BACKUP_KEY_FILE"
[ -d "$FILES_ROOT" ] || fail "FILES_ROOT no existe"
if [ -z "${BACKUP_UPLOAD_CMD:-}" ] && [ "${ALLOW_LOCAL_ONLY:-0}" != 1 ]; then
  fail "sin BACKUP_UPLOAD_CMD la copia no saldría del VPS; define el destino externo"
fi
mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d "$BACKUP_DIR/.work.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
[ -n "${PGPASS_FILE:-}" ] && setup_pgpass "$PGPASS_FILE" "$work"
uri=$(tr -d '\n' < "$PGURI_FILE")
case "$uri" in *://*:*@*) fail "la URI no debe llevar contraseña: usa PGPASS_FILE" ;; esac

# Recuentos primero, volcado después, archivos al final: un archivo subido entre medias aparece como
# huérfano (inofensivo); si falta uno referenciado, el simulacro de restauración lo detecta y se repite.
psql "$uri" -X -At -F: -c "SELECT table_name,(xpath('/row/c/text()',query_to_xml(format('select count(*) as c from %I.%I',table_schema,table_name),false,true,'')))[1]::text FROM information_schema.tables WHERE table_schema='llenamos' AND table_type='BASE TABLE' ORDER BY 1" > "$work/counts.txt"
pg_dump --format=custom --compress=6 --no-password --dbname "$uri" --file "$work/db.dump"
tar -C "$FILES_ROOT" --exclude=./.tmp -cf "$work/files.tar" .
# Registro de borrados de privacidad: viaja con la copia y también por separado (ledger.sh)
psql "$uri" -X -At -F "$(printf '\t')" -c "SELECT restaurant_id,subject_id FROM llenamos.privacy_requests WHERE kind='erase' AND status='completed' ORDER BY completed_at,id" > "$work/erasures.tsv"

{
  printf '{"version":1,"createdAt":"%s","dbSha256":"%s","filesSha256":"%s","tables":{' "$stamp" "$(sha256sum "$work/db.dump" | cut -d' ' -f1)" "$(sha256sum "$work/files.tar" | cut -d' ' -f1)"
  sed 's/^\([^:]*\):\(.*\)$/"\1":\2/' "$work/counts.txt" | paste -sd, -
  printf '}}\n'
} > "$work/manifest.json"

name="llenamos-$stamp.tar.enc"
tar -C "$work" -cf "$work/bundle.tar" db.dump files.tar manifest.json erasures.tsv
encrypt "$work/bundle.tar" "$BACKUP_DIR/$name" "$BACKUP_KEY_FILE"
mac_of "$BACKUP_DIR/$name" "$BACKUP_KEY_FILE" > "$BACKUP_DIR/$name.hmac"

if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  for part in "$name" "$name.hmac"; do
    BACKUP_FILE="$BACKUP_DIR/$part" BACKUP_NAME="$part" sh -c "$BACKUP_UPLOAD_CMD" || fail "no se pudo subir $part al destino externo"
  done
fi
find "$BACKUP_DIR" -maxdepth 1 -name 'llenamos-*.tar.enc*' -mtime "+${BACKUP_RETENTION_DAYS:-7}" -delete
echo "copia $name creada$( [ -n "${BACKUP_UPLOAD_CMD:-}" ] && echo ' y enviada fuera del VPS' )"
