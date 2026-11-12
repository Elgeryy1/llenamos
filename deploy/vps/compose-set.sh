# Conjunto de ficheros de compose del VPS, compartido por release.sh y check-no-rehearsal.sh para que la guardia
# valide EXACTAMENTE lo que se despliega. Se usa con `.` (source); no ejecuta nada por sí mismo.
#   VPS_ENV_FILES: ficheros de entorno (uno por línea), en orden de precedencia.
#   vps_compose '<subcomando y argumentos>'   p. ej.  vps_compose 'config --format json'
vps_compose_dir=$(cd "$(dirname "${BASH_SOURCE:-$0}")" && pwd)
vps_compose() {
  _sub=$1
  _mail=''
  _here=${VPS_COMPOSE_DIR:-$vps_compose_dir}
  set --
  _ifs=$IFS
  IFS='
'
  for _f in ${VPS_ENV_FILES:-}; do set -- "$@" --env-file "$_f"; done
  IFS=$_ifs
  for _f in compose.yaml compose.postgres.yaml compose.api.yaml compose.identity.yaml compose.worker.yaml; do
    set -- "$@" -f "$_here/$_f"
  done
  # compose.mail.yaml solo con remitente configurado en alguno de los entornos (requiere variables reales).
  _ifs=$IFS
  IFS='
'
  for _f in ${VPS_ENV_FILES:-}; do
    if grep -Eq '^[[:space:]]*(export[[:space:]]+)?PLATFORM_EMAIL_(FROM|ENABLED)[[:space:]]*[=:]' "$_f" 2>/dev/null; then _mail=1; fi
  done
  IFS=$_ifs
  if [ "${_mail:-}" = 1 ]; then set -- "$@" -f "$_here/compose.mail.yaml"; fi
  # shellcheck disable=SC2086
  docker compose "$@" --project-directory "$_here" --profile vps-backend --profile backup --profile public $_sub
}
