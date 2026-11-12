#!/bin/sh
# Registro de borrados de privacidad FUERA de la base: lista acumulativa (restaurante, id opaco de la persona) de
# todas las solicitudes de borrado completadas, cifrada y firmada con la clave de custodia y enviada al destino
# externo. Se programa a menudo (p. ej. cada hora), más que las copias completas. Tras restaurar una copia
# anterior, restore-drill.sh vuelve a borrar a quien figure aquí y no esté ya borrado en la copia.
# Mismas variables que backup.sh (no necesita FILES_ROOT).
set -eu
umask 077
here=$(dirname "$0")
. "$here/lib.sh"
: "${PGURI_FILE:?}" "${BACKUP_KEY_FILE:?}" "${BACKUP_DIR:?}"
check_key "$BACKUP_KEY_FILE"
if [ -z "${BACKUP_UPLOAD_CMD:-}" ] && [ "${ALLOW_LOCAL_ONLY:-0}" != 1 ]; then fail "sin BACKUP_UPLOAD_CMD el registro no saldría del VPS"; fi
mkdir -p "$BACKUP_DIR"
work=$(mktemp -d "$BACKUP_DIR/.work.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
[ -n "${PGPASS_FILE:-}" ] && setup_pgpass "$PGPASS_FILE" "$work"
uri=$(tr -d '\n' < "$PGURI_FILE")
case "$uri" in *://*:*@*) fail "la URI no debe llevar contraseña: usa PGPASS_FILE" ;; esac
psql "$uri" -X -At -F "$(printf '\t')" -c "SELECT restaurant_id,subject_id FROM llenamos.privacy_requests WHERE kind='erase' AND status='completed' ORDER BY completed_at,id" > "$work/erasures.tsv"
name="llenamos-ledger-$(date -u +%Y%m%dT%H%M%SZ).tsv.enc"
encrypt "$work/erasures.tsv" "$BACKUP_DIR/$name" "$BACKUP_KEY_FILE"
mac_of "$BACKUP_DIR/$name" "$BACKUP_KEY_FILE" > "$BACKUP_DIR/$name.hmac"
if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  for part in "$name" "$name.hmac"; do BACKUP_FILE="$BACKUP_DIR/$part" BACKUP_NAME="$part" sh -c "$BACKUP_UPLOAD_CMD" || fail "no se pudo subir $part"; done
fi
find "$BACKUP_DIR" -maxdepth 1 -name 'llenamos-ledger-*' -mtime "+${BACKUP_RETENTION_DAYS:-7}" -delete
echo "registro $name creado ($(wc -l < "$work/erasures.tsv") borrados)"
