# Funciones comunes de copia y restauración. Se carga con `.`; no se ejecuta solo.
POSTGRES_IMAGE_DEFAULT='postgres:18.4-bookworm@sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382'

fail() { echo "ERROR: $*" >&2; exit 1; }

# La clave de custodia (64 hex) nunca se usa directa: se derivan una clave de cifrado y otra de autenticación.
# Ninguna clave viaja como argumento de un proceso (se vería con `ps`): solo por stdin, ficheros 0600 o builtins.
derive() { printf '%s:%s' "$1" "$(tr -d '\n' < "$2")" | sha256sum | cut -d' ' -f1; }
check_key() {
  [ -r "$1" ] || fail "no se puede leer la clave de custodia"
  tr -d '\n' < "$1" | grep -Eq '^[0-9a-f]{64}$' || fail "la clave de custodia debe ser hexadecimal de 32 bytes"
}

# HMAC-SHA256 sin pasar la clave a ningún proceso: ipad/opad se construyen con builtins (printf) y el
# contenido va por stdin a `openssl dgst`. Sigue RFC 2104 (clave de 32 bytes < bloque de 64).
hmac_file() { # $1 fichero, $2 clave de custodia
  _k=$(derive mac "$2"); _ipad=''; _opad=''; _i=1
  while [ "$_i" -le 64 ]; do
    if [ "$_i" -le 32 ]; then _b=$(printf '%s' "$_k" | cut -c$((2 * _i - 1))-$((2 * _i))); _n=$((0x$_b)); else _n=0; fi
    _ipad="$_ipad$(printf '\\%03o' $((_n ^ 0x36)))"; _opad="$_opad$(printf '\\%03o' $((_n ^ 0x5c)))"
    _i=$((_i + 1))
  done
  _tmp=$(mktemp)
  { printf "$_ipad"; cat "$1"; } | openssl dgst -sha256 -binary > "$_tmp"
  { printf "$_opad"; cat "$_tmp"; } | openssl dgst -sha256 -r | cut -d' ' -f1
  rm -f "$_tmp"; unset _k _ipad _opad
}
mac_of() { hmac_file "$1" "$2"; }

# Cifrado AES-256-CBC (PBKDF2) con la passphrase derivada en un fichero 0600 temporal (`-pass file:`).
with_passfile() { # $1 clave de custodia; el resto: comando con PASSFILE exportado
  _pf=$(mktemp); derive enc "$1" > "$_pf"; shift
  PASSFILE=$_pf "$@"; _rc=$?; rm -f "$_pf"; return $_rc
}
_enc() { openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass "file:$PASSFILE" -in "$1" -out "$2"; }
_dec() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass "file:$PASSFILE" -in "$1" -out "$2"; }
encrypt() { with_passfile "$3" _enc "$1" "$2"; }
decrypt() { with_passfile "$3" _dec "$1" "$2"; }

# Contraseña de PostgreSQL por fichero .pgpass (libpq exige 0600 y propietario): se copia a un temporal privado.
setup_pgpass() { # $1 fichero origen con "host:puerto:base:usuario:contraseña", $2 directorio de trabajo
  [ -r "$1" ] || fail "no se puede leer el fichero de contraseña de PostgreSQL"
  cp "$1" "$2/.pgpass" && chmod 600 "$2/.pgpass"; PGPASSFILE="$2/.pgpass"; export PGPASSFILE
}
