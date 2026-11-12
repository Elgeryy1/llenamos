#!/bin/sh
# Prueba de release.sh con un `docker` falso: el render (config) usa el docker real; pull/up/ps/inspect se registran.
# Comprueba el bloqueo por defecto, que la guardia corre ANTES de pull/up, que se levantan api y worker y el rollback.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT HUP INT TERM
real=$(command -v docker)
digest=0000000000000000000000000000000000000000000000000000000000000000
mkdir "$tmp/bin" "$tmp/app"
cat > "$tmp/bin/docker" <<STUB
#!/bin/sh
case " \$* " in
  *" config "*) exec "$real" "\$@" ;;
esac
echo "\$*" >> "$tmp/log"
case " \$* " in
  *" up "*) if [ -f "$tmp/up-fails" ] && echo " \$* " | grep -q -- "--env-file .env.candidate" && echo " \$* " | grep -q gateway; then exit 1; fi ;;
  *" exec "*) echo false ;;
  run*) echo verificador ;;
  *" ps "*) echo contenedor123 ;;
  inspect*) echo '["NODE_ENV=production"]' ;;
esac
exit 0
STUB
chmod +x "$tmp/bin/docker"
cp "$here"/release.sh "$here"/base-de-datos.sh "$here"/scram.mjs "$here"/check-no-rehearsal.sh "$here"/compose-set.sh "$here"/compose*.yaml "$tmp/app/"
newenv() { # imágenes viejas con la misma forma
  for k in WEB GATEWAY API BACKUP; do
    l=$(echo "$k" | tr A-Z a-z)
    echo "${k}_IMAGE=ghcr.io/logiqd/llenamos-$l@sha256:$1"
  done
}
base_env() { # resto de .env de producción
  cat <<ENV
TUNNEL_IMAGE=cloudflare/cloudflared@sha256:$digest
PUBLIC_APP_URL=https://app-llenamos.logiqd.me
BACKUP_UPLOAD_CMD=true
ENV
}
old=1111111111111111111111111111111111111111111111111111111111111111
new=2222222222222222222222222222222222222222222222222222222222222222
mkdir "$tmp/app/secrets"; for s in bootstrap_database_url pw_api pw_worker pw_webhook pw_backup; do echo x > "$tmp/app/secrets/$s"; done
reset() { : > "$tmp/log"; rm -f "$tmp/up-fails" "$tmp/app/.env.previous" "$tmp/app/.env.candidate"; { newenv "$old"; base_env; } > "$tmp/app/.env"; newenv "$new" > "$tmp/release.env"; }
run() { PATH="$tmp/bin:$PATH" sh "$tmp/app/release.sh" "$tmp/release.env"; }
enable() { cp "$here/release.sh" "$tmp/app/release.sh"; }

# 1) Con el freno de emergencia puesto: ni docker ni cambios.
reset; sed 's/^RELEASE_BLOCKED=0/RELEASE_BLOCKED=1/' "$here/release.sh" > "$tmp/app/release.sh"
if run >"$tmp/out" 2>&1; then echo 'FALLO: el freno RELEASE_BLOCKED=1 no detiene release.sh' >&2; exit 1; fi
grep -q 'Despliegue detenido' "$tmp/out"; test ! -s "$tmp/log"

# 2) Con ensayo en .env, la guardia corta antes de pull/up.
reset; enable; echo 'NODE_ENV=rehearsal' >> "$tmp/app/.env"
if run >"$tmp/out" 2>&1; then echo 'FALLO: aceptó un .env con ensayo' >&2; exit 1; fi
grep -q 'ensayo' "$tmp/out"; ! grep -Eq ' (pull|up) ' "$tmp/log" || { echo 'FALLO: tocó contenedores antes de la guardia' >&2; exit 1; }

# 2b) Dos API_IMAGE en release.env (la buena y luego la de un repositorio ajeno): se rechaza antes de tocar nada.
reset; enable; echo "API_IMAGE=ghcr.io/atacante/api@sha256:$new" >> "$tmp/release.env"
if run >"$tmp/out" 2>&1; then echo 'FALLO: aceptó API_IMAGE duplicada' >&2; exit 1; fi
grep -q 'exactamente una vez' "$tmp/out"; ! grep -Eq ' (pull|up) ' "$tmp/log"

# 3) Release buena: pull y up incluyen api y worker, se promueve .env.
reset; enable
run >"$tmp/out" 2>&1 || { cat "$tmp/out" >&2; echo 'FALLO: release buena rechazada' >&2; exit 1; }
grep -E ' up ' "$tmp/log" | grep -q 'postgres api worker web gateway' || { echo 'FALLO: up sin api y worker' >&2; cat "$tmp/log" >&2; exit 1; }
grep -E ' pull ' "$tmp/log" | grep -q 'api worker' 
grep -q "llenamos-api@sha256:$new" "$tmp/app/.env"; test ! -e "$tmp/app/.env.candidate"
# La migración corre con la imagen API nueva, después del pull y antes de levantar la aplicación.
grep -n "llenamos-api@sha256:$new node dist/migrate.js" "$tmp/log" > /dev/null || { echo 'FALLO: sin migración con la imagen nueva' >&2; cat "$tmp/log" >&2; exit 1; }
m=$(grep -n 'dist/migrate.js' "$tmp/log" | head -1 | cut -d: -f1); u=$(grep -n ' up .*gateway' "$tmp/log" | head -1 | cut -d: -f1); p=$(grep -n ' pull ' "$tmp/log" | head -1 | cut -d: -f1)
test "$p" -lt "$m" && test "$m" -lt "$u" || { echo 'FALLO: orden pull, migración, up' >&2; exit 1; }

# 4) up falla con el candidato: rollback con .env.previous incluyendo api y worker; .env no cambia.
reset; enable; touch "$tmp/up-fails"
if run >"$tmp/out" 2>&1; then echo 'FALLO: release no saludable aceptada' >&2; exit 1; fi
grep -q 'se vuelve a la anterior' "$tmp/out"
grep -E ' up ' "$tmp/log" | tail -1 | grep -q -- "--env-file .env.previous" || { echo 'FALLO: sin rollback a .env.previous' >&2; cat "$tmp/log" >&2; exit 1; }
grep -E ' up ' "$tmp/log" | tail -1 | grep -q 'api worker'
grep -q "llenamos-api@sha256:$old" "$tmp/app/.env"
echo 'ok: freno de emergencia; migración entre pull y up; guardia antes de levantar; api y worker incluidos; rollback a .env.previous'
