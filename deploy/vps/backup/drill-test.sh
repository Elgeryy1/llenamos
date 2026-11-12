#!/bin/sh
# Prueba de extremo a extremo en Docker usando el servicio REAL `backup` y `ledger` de compose.worker.yaml (imagen propia,
# uid 1000, volúmenes nombrados, secretos por fichero) contra el PostgreSQL de compose.postgres.yaml. Después restaura con
# restore-drill.sh. Comprueba también copia manipulada, clave equivocada, archivo alterado, URI con contraseña, borrados
# posteriores a la copia y revocación de credenciales. Solo contenedores y carpetas temporales; nada de la nube.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
deploy="$repo/deploy/vps"
. "$here/lib.sh"
project="llb-$$"
tmp=$(mktemp -d)
chmod 755 "$tmp"
backup_image="llenamos-backup:drill-$$"
cleanup() {
  dc down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker rmi -f "$backup_image" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT HUP INT TERM

docker build -q -t "$backup_image" "$here" >/dev/null
umask 077
openssl rand -hex 32 > "$tmp/key"; openssl rand -hex 32 > "$tmp/other-key"; openssl rand -hex 24 > "$tmp/pgpassword"
for f in api_database_url worker_database_url webhook_database_url platform_invitation_key platform_integration_key sala_secret_key vapid_private_key firebase_auth_admin.json tunnel_token; do : > "$tmp/$f"; done
printf '%s' "$(cat "$tmp/pgpassword")" > "$tmp/postgres_bootstrap_password"
printf 'postgresql://llenamos_bootstrap@postgres:5432/llenamos' > "$tmp/backup_database_url"
printf 'postgres:5432:llenamos:llenamos_bootstrap:%s\n' "$(cat "$tmp/pgpassword")" > "$tmp/backup_pgpass"
cp "$tmp/key" "$tmp/backup_custody_key"
cat > "$tmp/env" <<EOF
WEB_IMAGE=ghcr.io/logiqd/llenamos-web@sha256:0000000000000000000000000000000000000000000000000000000000000000
GATEWAY_IMAGE=ghcr.io/logiqd/llenamos-gateway@sha256:0000000000000000000000000000000000000000000000000000000000000000
TUNNEL_IMAGE=cloudflare/cloudflared@sha256:0000000000000000000000000000000000000000000000000000000000000000
API_IMAGE=ghcr.io/logiqd/llenamos-api@sha256:0000000000000000000000000000000000000000000000000000000000000000
BACKUP_IMAGE=$backup_image
PUBLIC_APP_URL=https://app.example.test
BACKUP_UPLOAD_CMD=mkdir -p /backups/outbox && cp "\$\$BACKUP_FILE" /backups/outbox/
POSTGRES_BOOTSTRAP_PASSWORD_FILE=$tmp/postgres_bootstrap_password
API_DATABASE_URL_FILE=$tmp/api_database_url
WORKER_DATABASE_URL_FILE=$tmp/worker_database_url
WEBHOOK_DATABASE_URL_FILE=$tmp/webhook_database_url
BACKUP_DATABASE_URL_FILE=$tmp/backup_database_url
BACKUP_PGPASS_FILE=$tmp/backup_pgpass
BACKUP_CUSTODY_KEY_FILE=$tmp/backup_custody_key
FIREBASE_AUTH_ADMIN_FILE=$tmp/firebase_auth_admin.json
PLATFORM_INVITATION_KEY_FILE=$tmp/platform_invitation_key
PLATFORM_INTEGRATION_KEY_FILE=$tmp/platform_integration_key
SALA_SECRET_KEY_FILE=$tmp/sala_secret_key
VAPID_PRIVATE_KEY_FILE=$tmp/vapid_private_key
EOF
chmod -R a+rX "$tmp"; chmod 644 "$tmp"/*
dc() { docker compose -p "$project" --env-file "$tmp/env" -f "$deploy/compose.yaml" -f "$deploy/compose.postgres.yaml" -f "$deploy/compose.api.yaml" -f "$deploy/compose.identity.yaml" -f "$deploy/compose.worker.yaml" --profile vps-backend --profile backup "$@"; }
psqlc() { dc exec -T postgres psql -U llenamos_bootstrap -d llenamos -X -q -At -v ON_ERROR_STOP=1 "$@"; }

dc up -d --wait --wait-timeout 120 postgres >/dev/null
for f in "$repo"/apps/api/migrations/*.sql; do psqlc < "$f" >/dev/null; done
psqlc <<'SQL'
INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES('owner-a',repeat('a',32),now(),false),('owner-b',repeat('b',32),now(),false);
INSERT INTO llenamos.restaurants(id,name,slug) VALUES('tenant-a','Casa A','tenant-a'),('tenant-b','Casa B','tenant-b');
INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES('tenant-a','owner-a','owner',true,'A','a@example.test'),('tenant-b','owner-b','owner',true,'B','b@example.test');
INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload) VALUES(gen_random_uuid(),'tenant-a','mensaje.enviar','{}'),(gen_random_uuid(),'tenant-b','mensaje.enviar','{}');
INSERT INTO llenamos.integration_secrets(restaurant_id,ciphertext) VALUES('tenant-a',repeat('x',60));
INSERT INTO llenamos.integration_webhook_secrets(restaurant_id,provider,ciphertext) VALUES('tenant-a','stripe',repeat('y',60));
INSERT INTO llenamos.privacy_tombstones(restaurant_id,subject_hash) VALUES('tenant-a',repeat('c',64));
INSERT INTO llenamos.privacy_requests(id,restaurant_id,subject_id,kind,status,requested_by,reason,request_key,request_hash,completed_at)
  VALUES(gen_random_uuid(),'tenant-a','cus-viejo','erase','completed','owner-a','x','k-viejo',repeat('0',64),now());
SQL
dc create backup >/dev/null
vol=$(docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.volume=files_data)
# Equivale a lo que hace la imagen de la API: /data/files del usuario `node` (uid 1000); los archivos con 0600/0700 como storage.ts.
helper() { docker run --rm --entrypoint sh "$@"; }
helper --user 0:0 -v "$vol:/data/files" "$backup_image" -c 'chown 1000:1000 /data/files'
helper --user 1000:1000 -v "$vol:/data/files" "$backup_image" -c 'umask 077; mkdir -p /data/files/tenant-a/ab /data/files/tenant-b/cd; printf foto-a > /data/files/tenant-a/ab/ab000000-0000-0000-0000-000000000001; printf foto-b > /data/files/tenant-b/cd/cd000000-0000-0000-0000-000000000002; ls -l /data/files/tenant-a/ab | grep -q "^-rw-------"'
for row in "tenant-a ab000000-0000-0000-0000-000000000001 foto-a" "tenant-b cd000000-0000-0000-0000-000000000002 foto-b"; do
  set -- $row
  psqlc -c "INSERT INTO llenamos.files(id,restaurant_id,purpose,owner_uid,content_type,size_bytes,sha256) VALUES('$2','$1','carta_foto','x','image/jpeg',6,'$(printf %s "$3" | sha256sum | cut -d' ' -f1)')"
done

# 0) La imagen trae las herramientas de subida.
dc run --rm --no-deps --entrypoint sh backup -c 'command -v rsync && command -v ssh && command -v pg_dump' >/dev/null || fail "la imagen de copias no trae rsync/ssh/pg_dump"
echo "ok: la imagen de copias trae rsync, ssh y pg_dump"
# 1) Sin destino externo no hay copia; con contraseña en la URI tampoco.
if dc run --rm --no-deps -e BACKUP_UPLOAD_CMD= backup >/dev/null 2>&1; then fail "la copia debería rechazarse sin destino externo"; fi
echo "ok: sin destino externo se rechaza"
printf 'postgresql://llenamos_bootstrap:secreto@postgres:5432/llenamos' > "$tmp/uri_with_password"; chmod 644 "$tmp/uri_with_password"
if dc run --rm --no-deps -v "$tmp/uri_with_password:/run/secrets/backup_database_url:ro" backup >/dev/null 2>&1; then fail "una URI con contraseña debe rechazarse"; fi
echo "ok: una URI con contraseña se rechaza (la contraseña va en un fichero .pgpass)"
# 2) Copia con el servicio real del compose, como uid 1000, leyendo archivos 0600 y escribiendo en el volumen /backups.
dc run --rm backup
fetch() { dc run --rm --no-deps --entrypoint sh backup -c "cat /backups/outbox/$1" > "$2"; }
name=$(dc run --rm --no-deps --entrypoint sh backup -c 'ls /backups/outbox' | tr -d '\r' | grep -E '^llenamos-[0-9TZ]+\.tar\.enc$' | head -1)
[ -n "$name" ] || fail "no llegó ninguna copia al destino"
fetch "$name" "$tmp/bundle.tar.enc"; fetch "$name.hmac" "$tmp/bundle.tar.enc.hmac"
if grep -qa 'Casa A' "$tmp/bundle.tar.enc"; then fail "la copia cifrada contiene texto plano"; fi
echo "ok: copia cifrada con el servicio del compose y enviada al destino"
# 3) Borrado de privacidad posterior a la copia: solo vive en la base y en el registro externo.
psqlc <<'SQL'
INSERT INTO llenamos.privacy_requests(id,restaurant_id,subject_id,kind,status,requested_by,reason,request_key,request_hash,completed_at)
  VALUES(gen_random_uuid(),'tenant-a','cus-tardio','erase','completed','owner-a','x','k-tardio',repeat('0',64),now());
SQL
dc run --rm ledger
ledger=$(dc run --rm --no-deps --entrypoint sh backup -c 'ls /backups/outbox' | tr -d '\r' | grep -E '^llenamos-ledger-.*\.tsv\.enc$' | head -1)
[ -n "$ledger" ] || fail "el registro de borrados no llegó al destino"
fetch "$ledger" "$tmp/ledger.tsv.enc"; fetch "$ledger.hmac" "$tmp/ledger.tsv.enc.hmac"
echo "ok: registro de borrados enviado fuera de la base"
# 4) Copia manipulada, y clave equivocada: se rechazan antes de descifrar.
cp "$tmp/bundle.tar.enc" "$tmp/tampered.tar.enc"; cp "$tmp/bundle.tar.enc.hmac" "$tmp/tampered.tar.enc.hmac"
printf 'x' | dd of="$tmp/tampered.tar.enc" bs=1 seek=100 conv=notrunc 2>/dev/null
if sh "$here/restore-drill.sh" "$tmp/tampered.tar.enc" "$tmp/key" >/dev/null 2>&1; then fail "una copia manipulada no debe restaurarse"; fi
echo "ok: copia manipulada rechazada"
if sh "$here/restore-drill.sh" "$tmp/bundle.tar.enc" "$tmp/other-key" >/dev/null 2>&1; then fail "con otra clave no debe restaurarse"; fi
echo "ok: clave equivocada rechazada"
cp "$tmp/ledger.tsv.enc" "$tmp/ledger-bad.tsv.enc"; cp "$tmp/ledger.tsv.enc.hmac" "$tmp/ledger-bad.tsv.enc.hmac"; printf 'x' | dd of="$tmp/ledger-bad.tsv.enc" bs=1 seek=40 conv=notrunc 2>/dev/null
if sh "$here/restore-drill.sh" "$tmp/bundle.tar.enc" "$tmp/key" "$tmp/ledger-bad.tsv.enc" >/dev/null 2>&1; then fail "un registro de borrados manipulado debe rechazarse"; fi
echo "ok: registro de borrados manipulado rechazado"
# 5) Archivo alterado en el volumen: la copia se hace, pero el simulacro la rechaza.
helper --user 1000:1000 -v "$vol:/data/files" "$backup_image" -c 'umask 077; printf alterada > /data/files/tenant-a/ab/ab000000-0000-0000-0000-000000000001'
sleep 1; dc run --rm -e BACKUP_UPLOAD_CMD='mkdir -p /backups/outbox && cp "$BACKUP_FILE" /backups/outbox/' backup >/dev/null
broken=$(dc run --rm --no-deps --entrypoint sh backup -c 'ls -t /backups/outbox' | tr -d '\r' | grep -E '^llenamos-[0-9TZ]+\.tar\.enc$' | head -1)
[ "$broken" != "$name" ] || fail "no se generó la segunda copia"
fetch "$broken" "$tmp/broken.tar.enc"; fetch "$broken.hmac" "$tmp/broken.tar.enc.hmac"
if sh "$here/restore-drill.sh" "$tmp/broken.tar.enc" "$tmp/key" >/dev/null 2>&1; then fail "un archivo alterado debe hacer fallar el simulacro"; fi
echo "ok: archivo alterado detectado"
# 6) Restauración buena (copia anterior al borrado tardío + registro externo).
out=$(sh "$here/restore-drill.sh" "$tmp/bundle.tar.enc" "$tmp/key" "$tmp/ledger.tsv.enc")
echo "$out"
echo "$out" | grep -q 'borrados posteriores a la copia reaplicados: 1' || fail "debía reaplicarse exactamente el borrado tardío"
echo "$out" | grep -q 'credenciales de integración y tickets de descarga revocados' || fail "debían revocarse las credenciales"
# Sin el registro externo el borrado tardío NO se conoce: demuestra para qué sirve.
out2=$(sh "$here/restore-drill.sh" "$tmp/bundle.tar.enc" "$tmp/key")
echo "$out2" | grep -q 'reaplicados: 0' || fail "sin registro externo no debería haber reaplicados"
if docker ps -a --filter label=llenamos.test=restore-drill -q | grep -q .; then fail "queda un contenedor del simulacro"; fi
echo "PRUEBA DE COPIA Y RESTAURACIÓN SUPERADA"
