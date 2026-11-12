#!/bin/sh
# Ensayo de despliegue completo en el Docker del PC Compute (proyecto `llenamos-ensayo`). Desde la raíz del repositorio:
#   sh deploy/vps/ensayo/ensayo.sh <paso>
# Pasos: construir | preparar | subir | estado | recorrido | copia | carga | bajar (borra datos, conserva imágenes) | limpiar (todo)
# Solo crea y borra recursos del proyecto llenamos-ensayo (contenedores, red, volúmenes e imágenes `llenamos-ensayo/*`).
# Nunca ejecuta prune global ni toca contenedores, redes o volúmenes ajenos.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
deploy="$repo/deploy/vps"
run="$here/.run"
project=llenamos-ensayo
port=${ENSAYO_PORT:-18080}
base="http://127.0.0.1:$port"
node_image='node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d'

dc() {
  docker compose -p "$project" --env-file "$run/ensayo.env" \
    -f "$deploy/compose.yaml" -f "$deploy/compose.postgres.yaml" -f "$deploy/compose.api.yaml" -f "$deploy/compose.worker.yaml" \
    -f "$here/compose.ensayo.yaml" --profile vps-backend "$@"
}
psql_boot() { dc exec -T postgres psql -U llenamos_bootstrap -d llenamos -X -q -At -v ON_ERROR_STOP=1 "$@"; }

construir() {
  # Construye (sin publicar en ningún registro) web, gateway, API y copias. Las variables NEXT_PUBLIC son de ensayo y públicas.
  cd "$repo"
  label='--label com.logiqd.proyecto=llenamos-ensayo'
  site=https://ensayo.invalid
  args="--build-arg NEXT_PUBLIC_FIREBASE_PROJECT_ID=llenamos-ensayo --build-arg NEXT_PUBLIC_FIREBASE_API_KEY=ensayo-sin-nube --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=llenamos-ensayo.ensayo.invalid --build-arg NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET= --build-arg NEXT_PUBLIC_FIREBASE_APP_ID=1:0:web:ensayo --build-arg NEXT_PUBLIC_SITE_URL=$site --build-arg VITE_APP_URL=$site --build-arg NEXT_PUBLIC_DATA_BACKEND=postgres"
  # shellcheck disable=SC2086
  docker build $label -f deploy/vps/Dockerfile --target web $args -t llenamos-ensayo/web:ensayo .
  # shellcheck disable=SC2086
  docker build $label -f deploy/vps/Dockerfile --target gateway $args -t llenamos-ensayo/gateway:ensayo .
  docker build $label -f apps/api/Dockerfile -t llenamos-ensayo/api:ensayo .
  docker build $label -f deploy/vps/backup/Dockerfile -t llenamos-ensayo/backup:ensayo deploy/vps/backup
}

preparar() {
  umask 077
  mkdir -p "$run/secrets" "$run/externo" "$run/restauracion"
  chmod 700 "$run" "$run/secrets"
  chmod 777 "$run/externo"   # el contenedor de copias (uid 1000) escribe aquí; simula el destino externo
  s="$run/secrets"
  gen() { [ -s "$s/$1" ] || openssl rand -hex "$2" > "$s/$1"; }
  gen postgres_bootstrap_password 24
  for n in api worker webhook backup; do gen "pw_$n" 24; done
  gen platform_invitation_key 32
  gen platform_integration_key 32
  gen sala_secret_key 32
  : > "$s/vapid_private_key"   # sin avisos al móvil en el ensayo
  gen backup_custody_key 32
  : > "$s/backup_upload"   # el destino simulado es una carpeta: sin credenciales
  gen rehearsal_identity_secret 24
  gen operator_password 12
  pw() { tr -d '\n' < "$s/pw_$1"; }
  printf 'postgresql://llenamos_bootstrap:%s@postgres:5432/llenamos' "$(tr -d '\n' < "$s/postgres_bootstrap_password")" > "$s/bootstrap_database_url"
  printf 'postgresql://llenamos_api_login:%s@postgres:5432/llenamos' "$(pw api)" > "$s/api_database_url"
  printf 'postgresql://llenamos_worker_login:%s@postgres:5432/llenamos' "$(pw worker)" > "$s/worker_database_url"
  printf 'postgresql://llenamos_webhook_login:%s@postgres:5432/llenamos' "$(pw webhook)" > "$s/webhook_database_url"
  printf 'postgresql://llenamos_backup_login@postgres:5432/llenamos' > "$s/backup_database_url"
  printf 'postgres:5432:llenamos:llenamos_backup_login:%s\n' "$(pw backup)" > "$s/backup_pgpass"
  : > "$s/tunnel_token"
  cat > "$run/ensayo.env" <<ENV
WEB_IMAGE=llenamos-ensayo/web:ensayo
GATEWAY_IMAGE=llenamos-ensayo/gateway:ensayo
API_IMAGE=llenamos-ensayo/api:ensayo
BACKUP_IMAGE=llenamos-ensayo/backup:ensayo
TUNNEL_IMAGE=llenamos-ensayo/sin-tunel:no-usar
IDENTITY_IMAGE=$node_image
PUBLIC_APP_URL=https://ensayo.invalid
ENSAYO_EXTERNO_DIR=$run/externo
ENSAYO_IDENTITY_DIR=$here/identity
BACKUP_UPLOAD_CMD=cp "\$\$BACKUP_FILE" /external/
POSTGRES_BOOTSTRAP_PASSWORD_FILE=$s/postgres_bootstrap_password
BOOTSTRAP_DATABASE_URL_FILE=$s/bootstrap_database_url
API_DATABASE_URL_FILE=$s/api_database_url
WORKER_DATABASE_URL_FILE=$s/worker_database_url
WEBHOOK_DATABASE_URL_FILE=$s/webhook_database_url
BACKUP_DATABASE_URL_FILE=$s/backup_database_url
BACKUP_PGPASS_FILE=$s/backup_pgpass
BACKUP_CUSTODY_KEY_FILE=$s/backup_custody_key
BACKUP_UPLOAD_FILE=$s/backup_upload
PLATFORM_INVITATION_KEY_FILE=$s/platform_invitation_key
PLATFORM_INTEGRATION_KEY_FILE=$s/platform_integration_key
SALA_SECRET_KEY_FILE=$s/sala_secret_key
VAPID_PRIVATE_KEY_FILE=$s/vapid_private_key
REHEARSAL_IDENTITY_SECRET_FILE_PATH=$s/rehearsal_identity_secret
TUNNEL_TOKEN_FILE=$s/tunnel_token
ENV
  dc config --quiet && echo 'preparado: configuración de compose válida'
}

preflight() {
  # No pisar nada ajeno: el puerto del gateway y las dos subredes fijas de compose.yaml deben estar libres.
  if ss -ltnH | awk '{print $4}' | grep -Eq "[:.]$port\$"; then echo "El puerto $port ya está en uso; no se continúa." >&2; exit 1; fi
  for net in 172.30.42.0/28 172.30.43.0/28; do
    if docker network ls -q | xargs docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' | grep -v "^${project}_" | grep -q "${net%/*}"; then echo "La subred $net ya la usa otra red de Docker." >&2; exit 1; fi
  done
}

subir() {
  preflight
  # 1) Solo PostgreSQL; 2) migración con el rol bootstrap; 3) logins sin privilegios; 4) el resto, con espera de salud.
  dc up -d --wait --wait-timeout 120 postgres
  dc --profile migrate run --rm migrate
  # Las contraseñas de los roles no viajan en claro dentro del SQL (ni en el log del servidor): solo su verificador SCRAM.
  verifier() { tr -d '\n' < "$run/secrets/pw_$1" | node "$deploy/scram.mjs"; }
  api_v=$(verifier api); worker_v=$(verifier worker); webhook_v=$(verifier webhook); backup_v=$(verifier backup)
  psql_boot <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='llenamos_api_login') THEN
    CREATE ROLE llenamos_api_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '$api_v' IN ROLE llenamos_app;
    CREATE ROLE llenamos_worker_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '$worker_v' IN ROLE llenamos_app, llenamos_worker;
    CREATE ROLE llenamos_webhook_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '$webhook_v' IN ROLE llenamos_webhook;
    CREATE ROLE llenamos_backup_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD '$backup_v' IN ROLE pg_read_all_data;
  END IF;
  INSERT INTO llenamos.platform_flags(name, enabled) VALUES('rehearsal', true) ON CONFLICT(name) DO UPDATE SET enabled=true;
END \$\$;
SQL
  dc up -d --wait --wait-timeout 180 web gateway api worker identity
  curl -fsS "$base/api/readyz" && echo
}

estado() {
  dc ps
  echo '--- memoria (docker stats) ---'
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}' $(dc ps -q) || true
  echo '--- puertos publicados por el proyecto ---'
  docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}}\t{{.Ports}}'
}

copia() {
  # Copia cifrada con el servicio `backup` de compose (rol de solo lectura con BYPASSRLS), destino externo simulado en .run/externo,
  # y restauración aislada con restore-drill.sh (PostgreSQL desechable sin red). Más dos negativas: copia manipulada y clave equivocada.
  start=$(date +%s)
  dc --profile backup run --rm backup
  dc --profile backup run --rm ledger
  echo "copia + registro de borrados: $(( $(date +%s) - start )) s"
  ls -l "$run/externo"
  newest=$(ls -t "$run/externo"/llenamos-2*.tar.enc | head -1)
  ledger=$(ls -t "$run/externo"/llenamos-ledger-*.tsv.enc | head -1)
  key="$run/secrets/backup_custody_key"
  if grep -aqE 'Casa Ensayo|JFIF|propietaria@' "$newest"; then echo 'ERROR: la copia contiene datos en claro' >&2; exit 1; fi
  echo 'ok: la copia no contiene datos en claro'
  start=$(date +%s)
  sh "$deploy/backup/restore-drill.sh" "$newest" "$key" "$ledger"
  echo "restauración aislada: $(( $(date +%s) - start )) s"
  # Negativas
  cp "$newest" "$run/restauracion/manipulada.tar.enc"; cp "$newest.hmac" "$run/restauracion/manipulada.tar.enc.hmac"
  printf 'X' | dd of="$run/restauracion/manipulada.tar.enc" bs=1 seek=100 conv=notrunc 2>/dev/null
  if sh "$deploy/backup/restore-drill.sh" "$run/restauracion/manipulada.tar.enc" "$key" >/dev/null 2>&1; then echo 'ERROR: aceptó una copia manipulada' >&2; exit 1; fi
  echo 'ok: la copia manipulada se rechaza'
  openssl rand -hex 32 > "$run/restauracion/otra-clave"
  # 1) Clave equivocada con la firma original: la rechaza la comprobación de firma, antes de descifrar.
  out=$(sh "$deploy/backup/restore-drill.sh" "$newest" "$run/restauracion/otra-clave" 2>&1) && { echo 'ERROR: aceptó una clave equivocada' >&2; exit 1; }
  case "$out" in *'la firma de la copia no coincide'*) echo 'ok: la clave equivocada se rechaza en la firma (HMAC)';; *) echo "ERROR: rechazo por otra causa: $out" >&2; exit 1;; esac
  # 2) Firma válida PARA la clave equivocada sobre la copia cifrada con la buena: lo que la para es el descifrado.
  cp "$newest" "$run/restauracion/reiniciada.tar.enc"
  ( . "$deploy/backup/lib.sh"; hmac_file "$run/restauracion/reiniciada.tar.enc" "$run/restauracion/otra-clave" > "$run/restauracion/reiniciada.tar.enc.hmac" )
  out=$(sh "$deploy/backup/restore-drill.sh" "$run/restauracion/reiniciada.tar.enc" "$run/restauracion/otra-clave" 2>&1) && { echo 'ERROR: descifró con la clave equivocada' >&2; exit 1; }
  case "$out" in *'no se pudo descifrar la copia'*) echo 'ok: con la firma válida, la clave equivocada se rechaza al descifrar';; *) echo "ERROR: rechazo por otra causa: $out" >&2; exit 1;; esac
}

recorrido() { cd "$repo/apps/api" && pnpm exec tsx scripts/ensayo/recorrido.ts; }

carga() {
  # Muestrea la memoria de los contenedores del proyecto cada 3 s durante la carga y resume el máximo de cada uno.
  : > "$run/memoria.log"
  ( while :; do docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' $(dc ps -q) >> "$run/memoria.log" 2>/dev/null; sleep 3; done ) &
  sampler=$!
  trap 'kill $sampler 2>/dev/null || true' EXIT
  cd "$repo/apps/api" && pnpm exec tsx scripts/ensayo/carga.ts
  kill $sampler 2>/dev/null || true; trap - EXIT
  echo '--- memoria máxima observada (MiB) durante la carga ---'
  awk '{ v=$2; if (v ~ /GiB/) { sub(/GiB/,"",v); v=v*1024 } else { sub(/MiB/,"",v) } if (v+0 > m[$1]) m[$1]=v+0 } END { for (n in m) printf "%s %.0f\n", n, m[n] }' "$run/memoria.log" | sort
}

bajar() { dc --profile migrate --profile backup down --volumes --remove-orphans; rm -rf "$run/externo"/* "$run/restauracion"/*; }

limpiar() {
  # Solo el proyecto llenamos-ensayo: contenedores, redes y volúmenes con -v, e imágenes con su etiqueta.
  dc --profile migrate --profile backup down --volumes --remove-orphans || true
  for image in web gateway api backup; do docker rmi "llenamos-ensayo/$image:ensayo" 2>/dev/null || true; done
  rm -rf "$run"
  echo 'limpio: proyecto llenamos-ensayo'
}

cmd=${1:-}
case "$cmd" in
  construir|preparar|subir|estado|recorrido|copia|carga|bajar|limpiar) "$cmd" ;;
  *) echo "Uso: sh deploy/vps/ensayo/ensayo.sh construir|preparar|subir|estado|recorrido|copia|carga|bajar|limpiar" >&2; exit 2 ;;
esac
