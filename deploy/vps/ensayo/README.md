# Ensayo de despliegue (Docker del PC Compute como si fuera el VPS)

Levanta Llenamos completo (web, gateway nginx, API, worker, PostgreSQL y una identidad de ensayo) con el proyecto
`llenamos-ensayo`, sin túnel, sin dominios reales, sin nube y publicando solo `127.0.0.1:18080`. Resultados y hallazgos:
`docs/tareas/ENSAYO-DESPLIEGUE-V10.md`.

## Repetirlo (desde la raíz del repositorio)

```sh
sh deploy/vps/ensayo/ensayo.sh construir   # imágenes llenamos-ensayo/{web,gateway,api,backup}:ensayo, sin registro (~6 min la primera vez)
sh deploy/vps/ensayo/ensayo.sh preparar    # secretos aleatorios y llenamos-ensayo.env en deploy/vps/ensayo/.run (ignorado por git)
sh deploy/vps/ensayo/ensayo.sh subir       # postgres → migración con el rol bootstrap → logins sin privilegios → resto; comprueba /readyz
sh deploy/vps/ensayo/ensayo.sh recorrido   # alta, invitaciones, reserva pública, sala, cocina, caja, SSE, foto y worker
sh deploy/vps/ensayo/ensayo.sh copia       # copia cifrada con el servicio `backup`, destino externo simulado y restauración aislada
sh deploy/vps/ensayo/ensayo.sh carga       # 3 restaurantes con 120 días de histórico, tiempos y consultas lentas (≈4 min)
sh deploy/vps/ensayo/ensayo.sh estado      # contenedores, memoria y puertos
sh deploy/vps/ensayo/ensayo.sh bajar       # borra contenedores, red y volúmenes del proyecto; conserva las imágenes
sh deploy/vps/ensayo/ensayo.sh limpiar     # además borra las imágenes llenamos-ensayo/* y la carpeta .run
```

Requisitos: Docker con compose v2, `pnpm install` hecho, el puerto 18080 y las subredes 172.30.42.0/28 y 172.30.43.0/28
libres (`subir` lo comprueba y se detiene si no). Solo toca recursos con el prefijo `llenamos-ensayo`; no hay prune global.
Variables: `ENSAYO_PORT` (18080), `ENSAYO_SLUG` (recorrido), `CARGA_DIAS` (120), `CARGA_RPS` (14, ritmo del generador).

## Identidad de ensayo (no es Firebase)

Producción usa Firebase Auth real y la API rechaza emuladores. Para el ensayo, `identity/server.mjs` hace de Auth: firma ID tokens
RS256 con una clave local (`/home/node/identity.json`, volumen del proyecto), expone `/jwks.json` y administra cuentas
(`/admin/*`, con secreto). La API la usa solo si arranca con `NODE_ENV=rehearsal` y `REHEARSAL_IDENTITY_URL` +
`REHEARSAL_IDENTITY_SECRET_FILE` (`apps/api/src/config.ts`, `rehearsal-identity.ts`). Con cualquier otro `NODE_ENV`, incluido el
`production` de la imagen, el proceso se niega a arrancar. Garantías y pruebas:

- `apps/api/src/rehearsal-identity.test.ts` y `.integration.test.ts` (PostgreSQL real): configuración, firma, claims, alta →
  invitación → aceptación → sesión, token manipulado, otro proyecto y operador sin acceso al interior.
- `sh apps/api/scripts/rehearsal-reject-docker.sh llenamos-ensayo/api:ensayo`: la **imagen de producción** (sin tocar su entorno)
  rechaza la variable; también con `NODE_ENV` vacío, `development` o `Production`.
- `deploy/vps/check-no-rehearsal.sh` (llamado por `release.sh` antes de `pull`/`up`) rechaza en cada `.env` y en el entorno del proceso
  `REHEARSAL_*`, `ENSAYO_*`, `NODE_ENV` distinto de `production`, `COMPOSE_FILE`/`COMPOSE_PROFILES`/`COMPOSE_PROJECT_NAME` y
  cualquier valor que mencione el ensayo (admite `export` y `CLAVE: valor`). Después renderiza con `docker compose config --format json`
  el MISMO conjunto de ficheros que despliega `release.sh` (`compose-set.sh`) y lo valida en positivo con `jq`: servicios exactos,
  imágenes por digest, `NODE_ENV=production` en web, api y worker, sin rastro del ensayo. Sin docker falla (`REQUIRE_DOCKER=1`;
  `ALLOW_NO_DOCKER=1` solo permite la revisión de texto y avisa). Pruebas: `check-no-rehearsal.test.sh` (cada caso comprueba el
  mensaje) y `release.test.sh` (docker falso: guardia antes de levantar, api y worker, rollback).
- Barrera de base de datos: `platform_flags.rehearsal` (migración `015_rehearsal_flag.sql`) debe coincidir con el modo del proceso, en los
  dos sentidos, en la API (`checkReadiness`, `/readyz`) y en el worker (`worker-main.ts`). Si la marca no se puede leer, el proceso no
  arranca (no se asume «producción»). Prueba: `rehearsal-mark.integration.test.ts`.
- El secreto de la identidad solo vale en `/run/secrets/rehearsal_identity_secret` (se compara la ruta real, sin enlaces) y debe ser
  hexadecimal de 24 bytes. La contraseña de `cli.mjs` va solo por entrada estándar. Las contraseñas de los roles de PostgreSQL del
  ensayo se crean con verificador SCRAM (`scram.mjs`), no en claro.

Límites honestos: la interfaz web no puede iniciar sesión (usa el SDK de Firebase contra la nube), así que el recorrido ejerce la
API con tokens del servicio de ensayo; las páginas públicas se comprueban por HTML. No hay proveedor de correo: el token de la
invitación se descifra de la base con la clave de plataforma, como lo haría el correo. El destino externo de las copias es una carpeta.
