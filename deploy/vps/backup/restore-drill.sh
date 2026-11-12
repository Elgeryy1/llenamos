#!/bin/sh
# Restauración aislada de una copia en un PostgreSQL desechable (Docker), sin tocar producción.
# Uso: restore-drill.sh <llenamos-….tar.enc> <clave-de-custodia> [registro-de-borrados.tsv.enc …]
# Comprueba firma, hashes, restauración completa, recuentos, aislamiento por restaurante (RLS),
# integridad de archivos, deja en cuarentena todo lo que pudiera reenviar avisos o cobros, revoca las credenciales
# de integración y vuelve a borrar a las personas borradas después de la copia (los registros de borrado, que viven
# fuera de la base, se pasan como argumentos adicionales).
set -eu
umask 077
here=$(dirname "$0")
. "$here/lib.sh"
bundle=${1:?uso: restore-drill.sh copia.tar.enc clave}
key=${2:?uso: restore-drill.sh copia.tar.enc clave}
shift 2
image=${POSTGRES_IMAGE:-$POSTGRES_IMAGE_DEFAULT}
check_key "$key"
[ "$(mac_of "$bundle" "$key")" = "$(tr -d ' \n' < "$bundle.hmac")" ] || fail "la firma de la copia no coincide: no se descifra"
work=$(mktemp -d)
name="llenamos-drill-$$-$(date +%s)"
cleanup() { docker rm -fv "$name" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT HUP INT TERM
decrypt "$bundle" "$work/bundle.tar" "$key" || fail "no se pudo descifrar la copia"
mkdir "$work/in" && tar -C "$work/in" -xf "$work/bundle.tar"
manifest="$work/in/manifest.json"
# Borrados conocidos: los de la propia copia más los de cada registro externo (firmados y cifrados igual).
cat "$work/in/erasures.tsv" > "$work/erasures-all.tsv"
for ledger in "$@"; do
  [ "$(mac_of "$ledger" "$key")" = "$(tr -d ' \n' < "$ledger.hmac")" ] || fail "la firma del registro de borrados $ledger no coincide"
  decrypt "$ledger" "$work/ledger.tsv" "$key" || fail "no se pudo descifrar el registro de borrados"
  cat "$work/ledger.tsv" >> "$work/erasures-all.tsv"
done
sort -u "$work/erasures-all.tsv" > "$work/erasures.tsv"
[ "$(sha256sum "$work/in/db.dump" | cut -d' ' -f1)" = "$(sed -n 's/.*"dbSha256":"\([a-f0-9]*\)".*/\1/p' "$manifest")" ] || fail "hash del volcado SQL no coincide"
[ "$(sha256sum "$work/in/files.tar" | cut -d' ' -f1)" = "$(sed -n 's/.*"filesSha256":"\([a-f0-9]*\)".*/\1/p' "$manifest")" ] || fail "hash de los archivos no coincide"

docker run -d --name "$name" --label llenamos.test=restore-drill --network none --memory 512m --cpus 1 \
  -e POSTGRES_PASSWORD=drill-only-password -e POSTGRES_DB=drill "$image" >/dev/null
ready=0
for _ in $(seq 1 40); do
  if docker exec "$name" pg_isready -U postgres -d drill >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || fail "el PostgreSQL desechable no arrancó"
sql() { docker exec -i "$name" psql -U postgres -d drill -X -q -At -v ON_ERROR_STOP=1 "$@"; }
sql -c "DO \$\$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['llenamos_migrator','llenamos_app','llenamos_worker','llenamos_worker_fn','llenamos_platform_writer','llenamos_webhook'] LOOP
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS',r); END IF; END LOOP; END \$\$" >/dev/null
docker cp "$work/in/db.dump" "$name:/tmp/db.dump"
# Los propietarios que figuran en el volcado (p. ej. el rol de migración del servidor) deben existir para restaurar con ellos.
for owner in $(docker exec "$name" pg_restore -l /tmp/db.dump | grep -v '^;' | awk '{print $NF}' | sort -u | grep -E '^[a-z_][a-z0-9_]*$'); do
  sql -c "DO \$\$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='$owner') THEN CREATE ROLE $owner NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END \$\$" >/dev/null
done
docker exec "$name" pg_restore -U postgres -d drill --exit-on-error --no-password /tmp/db.dump || fail "pg_restore falló"

report=""
note() { report="$report$1\n"; echo "ok: $1"; }

# Recuentos de las tablas que no cambian con el tráfico normal.
for table in restaurants identities memberships locations files integration_secrets privacy_tombstones; do
  expected=$(sed -n "s/.*\"$table\":\([0-9]*\).*/\1/p" "$manifest")
  actual=$(sql -c "SELECT count(*) FROM llenamos.$table")
  [ "$expected" = "$actual" ] || fail "recuento de $table: copia $expected, restaurado $actual"
done
note "recuentos de tablas estables"

# Aislamiento: un miembro del restaurante A sigue sin ver nada del B tras restaurar (RLS y FORCE intactos).
pair=$(sql -c "SELECT a.restaurant_id||' '||a.uid||' '||b.restaurant_id FROM llenamos.memberships a JOIN llenamos.memberships b ON b.restaurant_id<>a.restaurant_id AND NOT EXISTS(SELECT 1 FROM llenamos.memberships c WHERE c.restaurant_id=b.restaurant_id AND c.uid=a.uid) WHERE a.active LIMIT 1")
if [ -n "$pair" ]; then
  set -- $pair
  sql -c "CREATE ROLE drill_probe NOLOGIN IN ROLE llenamos_app" >/dev/null
  seen=$(sql <<SQL | tail -1
BEGIN;
SET LOCAL ROLE drill_probe;
SELECT set_config('app.actor_uid','$2',true),set_config('app.restaurant_id','$1',true) \\g /dev/null
SELECT count(*) FROM llenamos.files WHERE restaurant_id='$3';
ROLLBACK;
SQL
)
  [ "$seen" = 0 ] || fail "aislamiento roto tras restaurar: un restaurante ve archivos de otro (visto: $seen)"
  own=$(sql <<SQL | tail -1
BEGIN;
SET LOCAL ROLE drill_probe;
SELECT set_config('app.actor_uid','$2',true),set_config('app.restaurant_id','$1',true) \\g /dev/null
SELECT count(*) FROM llenamos.memberships WHERE uid='$2';
ROLLBACK;
SQL
)
  [ "$own" -ge 1 ] || fail "el miembro no ve su propia pertenencia tras restaurar"
  sql -c "DROP ROLE drill_probe" >/dev/null
  note "aislamiento por restaurante (RLS) tras restaurar"
else
  note "aislamiento no comprobado: la copia tiene un solo restaurante"
fi

# Nada pendiente se reenvía solo: avisos, webhooks, cobros e impresiones de antes de la copia pasan a cuarentena.
quarantined=$(sql -c "WITH a AS (UPDATE llenamos.outbox SET status='quarantined',lease_id=NULL,lease_until=NULL,last_error='restauracion' WHERE status IN ('pending','leased') RETURNING 1),
  b AS (UPDATE llenamos.jobs SET status='quarantined',lease_id=NULL,lease_until=NULL,last_error='restauracion' WHERE status IN ('pending','leased') RETURNING 1)
  SELECT (SELECT count(*) FROM a)+(SELECT count(*) FROM b)")
note "colas en cuarentena: $quarantined elementos pendientes antes de la copia no se reenviarán"

# Credenciales de integración y enlaces de descarga no se reactivan solos: los restaurantes las vuelven a introducir.
sql -c "DELETE FROM llenamos.integration_webhook_secrets; DELETE FROM llenamos.integration_secrets; DELETE FROM llenamos.privacy_downloads; UPDATE llenamos.platform_restaurants SET integration_status=NULL" >/dev/null
[ "$(sql -c "SELECT (SELECT count(*) FROM llenamos.integration_secrets)+(SELECT count(*) FROM llenamos.integration_webhook_secrets)+(SELECT count(*) FROM llenamos.privacy_downloads)")" = 0 ] || fail "quedan credenciales o tickets activos"
note "credenciales de integración y tickets de descarga revocados: hay que volver a configurarlos"

# Las personas borradas después de la copia vuelven con ella: se reaplica su borrado (lo ejecuta el worker al arrancar,
# ANTES de reabrir la API). Cuenta lo reaplicado y comprueba que nada más queda reclamable.
reapplied=0
while IFS="$(printf '\t')" read -r rid subject; do
  [ -n "$rid" ] || continue
  done_one=$(printf '%s\n' "SELECT llenamos.restore_reapply_erasure(:'r',:'s')" | sql -v r="$rid" -v s="$subject")
  [ "$done_one" = t ] && reapplied=$((reapplied + 1))
done < "$work/erasures.tsv"
pendingErasures=$(sql -c "SELECT count(*) FROM llenamos.privacy_requests WHERE requested_by='restauracion' AND status='verified'")
claimable=$(sql -c "SELECT count(*) FROM llenamos.jobs WHERE status IN ('pending','leased') AND kind<>'privacidad.procesar'")
other=$(sql -c "SELECT count(*) FROM llenamos.outbox WHERE status IN ('pending','leased')")
[ "$claimable" = 0 ] && [ "$other" = 0 ] || fail "quedan trabajos reclamables distintos de los borrados reaplicados"
[ "$pendingErasures" = "$reapplied" ] || fail "los borrados reaplicados no coinciden ($pendingErasures solicitudes, $reapplied reaplicados)"
note "borrados posteriores a la copia reaplicados: $reapplied (el worker debe procesarlos antes de reabrir)"

# Archivos: todo archivo activo debe existir en el volumen restaurado con el mismo hash.
mkdir "$work/files" && tar -C "$work/files" -xf "$work/in/files.tar"
checked=0
for row in $(sql -c "SELECT restaurant_id||'|'||id||'|'||sha256 FROM llenamos.files WHERE status='active' ORDER BY id"); do
  rid=${row%%|*}; rest=${row#*|}; id=${rest%%|*}; hash=${rest#*|}
  file="$work/files/$rid/$(printf %s "$id" | cut -c1-2)/$id"
  [ -f "$file" ] || fail "falta el archivo $id del restaurante $rid en la copia"
  [ "$(sha256sum "$file" | cut -d' ' -f1)" = "$hash" ] || fail "el archivo $id no coincide con su hash"
  checked=$((checked + 1))
done
note "archivos activos verificados por hash: $checked"
tombstones=$(sql -c "SELECT count(*) FROM llenamos.privacy_tombstones")
note "huellas de borrado de privacidad conservadas: $tombstones"
echo "SIMULACRO SUPERADO. Pendiente manual al restaurar de verdad: reconciliar UID de Firebase Auth y revocaciones, y revisar la cuarentena."
