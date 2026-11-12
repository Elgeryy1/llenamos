# Despliegue VPS

**Estado: release desbloqueada (2026-11-12).** Firebase conserva sólo usuarios/login. `release.sh` aplica las migraciones
con `base-de-datos.sh` entre el pull y el arranque; la primera instalación es `sh base-de-datos.sh` y después `sh release.sh release.env`.
PostgreSQL, API, worker, archivos, realtime y copias pertenecen al VPS. Leer
`docs/tareas/PLAN-DEPLOY-VPS.md`, `PRODUCCION-ESTADO.md` y `DECISIONES.md`.
No publicar sólo el frontend como producto completo ni activar Blaze para el plan abandonado.

## Imágenes y verificación

Construir fuera del VPS desde la raíz del monorepo: web/gateway con los destinos homónimos
de `deploy/vps/Dockerfile`; API con `apps/api/Dockerfile`. Usar el mismo SHA. Configuración
pública real de Auth, `NEXT_PUBLIC_DATA_BACKEND=postgres`, emuladores desactivados y origen HTTPS
de la aplicación. Ninguna credencial privada se pasa al build.

El workflow manual `vps-images.yml` valida tipos/pruebas y SQL/proxy antes de construir imágenes
privadas en GHCR. Su artefacto contiene WEB_IMAGE, GATEWAY_IMAGE y API_IMAGE por digest.
La verificación completa del mismo SHA también debe pasar. Construir no despliega ni migra datos.
Pruebas reproducibles: `apps/api/scripts/test-postgres-docker.sh`,
`apps/api/scripts/smoke-image-docker.sh` y `nginx-security.test.mjs`.
Nunca ejecutar prune global ni tocar contenedores de HQ, Repite, n8n o Umbrel.

## Configuración preparada

Directorio propio futuro `/srv/llenamos` en el Docker host. No usar la DB de HQ.
Base de Compose: `compose.yaml`; añadir `compose.postgres.yaml` y `compose.api.yaml` con
perfil `vps-backend`. PostgreSQL no publica puertos. La API sólo está en redes internas y
su red de salida; el gateway dirige `/api/*` a `api:3100/*`.

La credencial bootstrap aplica migraciones y crea un login runtime sin privilegios, miembro
de llenamos_app. Nunca montar esa credencial en el proceso HTTP. DATABASE_URL_FILE contiene
sólo la conexión runtime. Consultar `apps/api/README.md` para roles, RLS y migraciones.
Comprobar persistencia, permisos, migraciones y salud antes de conectar datos reales.

`compose.identity.yaml` añade los archivos privados de Auth Admin y las dos claves separadas
para invitaciones y custodia por restaurante. La cuenta de servicio sólo necesita administración
de identidades; nunca Firestore/Storage. Sin este override, la base API de lectura puede arrancar,
pero el alta no está disponible. Los archivos deben poder leerse con UID1000 del contenedor API
y tener acceso restringido en el host. No guardar claves en git ni imprimirlas en logs.

`compose.mail.yaml` es opcional y exige además identity, un origen HTTPS real, remitente validado
y clave Resend de plataforma. Sin él, se puede dar de alta el restaurante con propietario pendiente;
no se entrega una contraseña/token al operador ni se anuncia correo enviado. La API opcional
del restaurante no sustituye este correo privado de plataforma.

Preparar `.env` desde el ejemplo; sólo referencias de imágenes, rutas y datos públicos.
Validar la combinación elegida con `docker compose ... config --quiet`. No ejecutar `up`
como release hasta superar la aceptación de todas las fases.

## Publicación y continuidad pendientes

Presentación/app en loopback8180/8181; HTTPS público mediante túnel dedicado con rutas al gateway
8080/8081 y cierre404. No modificar túneles ajenos. La red fija172.30.42.0/28 debe seguir libre:
sólo cloudflared172.30.42.2 aporta IP real confiable. Verificar que su usuario puede leer el token
montado. No incluir tokens, query, Referer ni rutas privadas en logs.

`compose.worker.yaml` añade el worker (128 MiB), el volumen privado de archivos compartido con la API y el
servicio `backup` (perfil `backup`). El login de PostgreSQL del worker se crea con el rol bootstrap:
`CREATE ROLE llenamos_worker_login LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS IN ROLE llenamos_app, llenamos_worker;`
y su URI va en `secrets/worker_database_url`. El receptor de webhooks usa otro login, `CREATE ROLE llenamos_webhook_login LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS IN ROLE llenamos_webhook;` (nunca miembro de `llenamos_app`), en `secrets/webhook_database_url`. La API no puede pertenecer a `llenamos_worker`. `secrets/sala_secret_key` (64 hex, `openssl rand -hex 32`) es la custodia de los enlaces de mesa y de seguimiento de recogida; API y worker montan la MISMA (si cambia, los enlaces emitidos dejan de abrirse; guardarla fuera del VPS junto al resto de claves). `secrets/vapid_private_key` (clave privada VAPID en base64url; puede estar vacío) con `VAPID_PUBLIC_KEY` y `VAPID_SUBJECT` en el `.env` activan los avisos al móvil de las tareas de sala vencidas; sin ellos no se envía nada. Para las copias,
un rol de solo lectura con `BYPASSRLS` (`pg_read_all_data`), una URI sin contraseña en `secrets/backup_database_url`, la
contraseña en `secrets/backup_pgpass` (formato `.pgpass`, para que no aparezca en argumentos de procesos) y `secrets/backup_custody_key` (64 hex, guardada también
fuera del VPS y nunca junto a las copias). La imagen `deploy/vps/backup/Dockerfile` (rsync y ssh incluidos, uid 1000 como la API) se compila fuera del VPS y se publica por digest como `BACKUP_IMAGE`. `ledger.sh` (servicio `ledger`, programarlo cada hora) envía fuera de la base el registro de borrados de privacidad; `restore-drill.sh` lo usa para volver a borrar a quien se borró después de la copia. `backup/backup.sh` genera una copia cifrada (pg_dump + archivos), la
firma con HMAC y la envía con `BACKUP_UPLOAD_CMD` (sin destino externo se niega a copiar). `backup/restore-drill.sh`
la restaura en un PostgreSQL desechable de Docker y comprueba firma, hashes, recuentos, aislamiento por
restaurante, hashes de archivos y deja la cola en cuarentena; `backup/drill-test.sh` lo prueba de extremo a extremo
(incluidas copia manipulada, clave equivocada y archivo alterado). El destino externo real (rsync/rclone) no se
ha podido probar aquí: la prueba usa una carpeta como destino. Restaurar de verdad exige además reconciliar los UID de
Firebase Auth y las revocaciones, y revisar la cuarentena antes de reabrir.

Faltan realtime, dominios operativos y la aceptación con proveedores reales. Health/readiness no prueban todas esas funciones ni los proveedores. No usar datos reales
hasta la aceptación de seguridad, concurrencia, carga, equipos y restauración.

`release.sh` termina explícitamente con error mientras esta migración esté incompleta.
El procedimiento final deberá incluir migración compatible, API/worker, comprobación de proveedores
y rollback de código; volver a una imagen anterior no deshace reservas ni cobros.

## Ensayo de despliegue

`deploy/vps/ensayo/` levanta todo esto en el Docker del PC Compute (proyecto `llenamos-ensayo`, solo `127.0.0.1:18080`), con una identidad de
ensayo que sustituye a Firebase Auth y que la API solo acepta con `NODE_ENV=rehearsal`. `release.sh` ejecuta `check-no-rehearsal.sh` (antes de `pull`/`up`, sobre el mismo
conjunto de compose que despliega), que rechaza cualquier rastro de ese modo en la release, en `.env` o en el entorno. Resultados: `docs/tareas/ENSAYO-DESPLIEGUE-V10.md`.

Al VPS (`/srv/llenamos`) se copian solo `release.sh`, `check-no-rehearsal.sh`, `compose-set.sh` y los `compose*.yaml` (no la carpeta
`ensayo/`, que `release.sh` rechaza si existe). La guardia revisa el texto de `release.env`, `.env` y `.env.candidate`, pero renderiza solo el
último (`.env.candidate`, el que se despliega); exige una sola línea por clave `*_IMAGE`, prohíbe `*_IMAGE` en el entorno del proceso y fija el
repositorio de cada imagen (`ghcr.io/logiqd/llenamos-*`, `postgres`, `cloudflare/cloudflared`).

## Memoria y conexiones

Topes (`mem_limit`): web 256 MiB, API 192, PostgreSQL 384, worker 128, gateway 64 y túnel 64 (1088 MiB en total).
`NODE_OPTIONS=--max-old-space-size` deja el heap por debajo del tope (web 160, API 144, worker 96; la web standalone mide unos 165 MiB de RSS con carga ligera). La web es la salida
`standalone` de Next.js. PostgreSQL va afinado para un servidor pequeño: `shared_buffers=128MB`, `work_mem=2MB`,
`max_connections=30`. Pools: API 12, receptor de webhooks 3 y worker 5 (20 conexiones); quedan 10 para migraciones,
copias, el cliente de escucha de eventos y las 3 reservadas del superusuario. No subir un pool sin revisar este reparto.
Propuesta no aplicada: la presentación ya se sirve estática desde el nginx del gateway (`apps/landing/dist`), sin Node.
La app (`app-llenamos`) necesita Node por `cacheComponents`/renderizado en servidor; ver el informe W5.

## Comprobación del bundle en la imagen

`deploy/vps/Dockerfile` tiene la etapa `bundle-check`: ejecuta `check-imports.mjs` (imports estáticos transitivos) y `check-bundle.mjs`
(escanea `.next`) y la imagen `web` depende de ella, así que no se construye si el bundle `postgres` lleva Firestore, Functions o Storage,
ni siquiera como chunk diferido. `gateway` no depende de esa etapa. Los SDK solo se cargan por `lib/firebase/cargar-demo.ts`
(guarda en línea `process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres"`); no muevas esa comparación a una función.

## Destino externo de las copias: Cloudflare R2

Bucket privado `llenamos-copias` con un token de R2 limitado a ese bucket. `secrets/backup_upload` lleva las credenciales en
formato de configuración de curl, `user = "ID_DE_ACCESO:SECRETO"`, y el `.env` del VPS define (con `$$` para que compose no interpole):

    BACKUP_UPLOAD_CMD=curl -fsS --retry 3 -K /run/secrets/backup_upload --aws-sigv4 aws:amz:auto:s3 -T "$$BACKUP_FILE" "https://<ID_DE_CUENTA>.r2.cloudflarestorage.com/llenamos-copias/$$BACKUP_NAME"

Las copias ya van cifradas y firmadas antes de salir; R2 solo guarda los ficheros. La clave de custodia no se sube nunca.
