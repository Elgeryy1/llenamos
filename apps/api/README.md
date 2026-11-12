# API VPS: cimientos

Implementado: servidor HTTP Node, verificación criptográfica Firebase Auth y acceso PostgreSQL
con sesión vigente y aislamiento de filas. **No están migradas las operaciones de reservas,
sala, caja ni el resto de dominios.** Un endpoint no implementado devuelve 404, nunca un éxito
ficticio. Este servicio todavía no está desplegado; el adaptador del frontend se prepara por separado.

Rutas iniciales:

- `GET /healthz`: proceso vivo; no demuestra acceso a datos.
- `GET /readyz`: comprueba conexión, rol y capacidades mínimas de esquema requeridas por los
  módulos registrados, sin acceso a credenciales bootstrap ni devolver información del servidor.
- `GET /v1/session`: Bearer Firebase ID token; perfil y membresías propias desde SQL.
- `GET /v1/restaurants/:rid/context`: restaurante, miembro propio y locales autorizados, validados
  con los contratos de core. Deniega al equipo LogiQD y al usuario ajeno al restaurante.
- `POST /v1/operations/listarRestaurantesAdministracion`: Bearer e identidad de plataforma
  autorizada en SQL; `{data:{cursor?:string|null,limit?:number}}` y `{result:{restaurants,nextCursor}}`.
  Pagina metadata administrativa, hasta 100 registros por página, sin leer documentos operativos.
- `GET /v1/admin/restaurants`: alias de lectura de la primera página administrativa.

El registry es explícito y valida entrada/salida con Zod y contratos de core. Están registrados
listado/alta/configuración de plataforma y catálogo de planes; los handlers de invitaciones/equipo
se registran al configurar administración de identidad. Ningún nombre se convierte en SQL o en un callable Firebase.
Las futuras operaciones privadas de restaurante deben declarar tenant y roles permitidos; por
defecto se deniegan. Catálogo y aceptación de invitación son públicos y tienen handlers explícitos.
Un handler ausente devuelve `404/not-deployed`, distinto de una entidad inexistente.
Entrada JSON limitada a 64 KiB,
cabeceras a 16 KiB y recepción a 15 segundos; consultas SQL a 10 segundos. Los errores tienen
`{error:{code,message,requestId}}` sin cuerpos ni credenciales en logs.

El proxy debe retirar `/api` del prefijo externo `/api/v1/...`. Los GET devuelven directamente
el objeto, y el POST usa el envelope de operaciones. `session.memberships` emplea camelCase:
`restaurantId`, `role`, `locationIds`, `name` y `slug`.

Las rutas usan `no-store`. No se admiten tokens por query ni credenciales elegidas por el browser.
No se devuelven campos de custodia, versión de sesión ni secretos. El claim `logiqd` no concede
administración sin la autorización SQL. Los operadores quedan fuera de tablas operativas incluso
si una membresía errónea los declara propietarios.

## Identidad

Verificador `jose` con claves SecureToken de un origen fijo (nunca `jku` del JWT), algoritmo RS256,
audiencia e issuer del proyecto esperado, exp/iat/sub/auth_time. El modo de producción no tiene
un atajo de JWT sin firma ni emuladores. Los tests inyectan claves/verificador aislados.

Cada UID exige fila SQL `identities`, no desactivada/bloqueada, con `session_version` hex32 que
coincida con customClaim `sessionVersion` y `auth_time` no anterior a `tokens_valid_after`.
No hay compatibilidad silenciosa con sesiones antiguas sin registro: el bootstrap/aceptación de
invitaciones debe generar esta fila y claim antes de activar una cuenta. Los roles están en SQL,
Firebase conserva únicamente identidad. La gestión administrativa de Auth para alta/aceptación
usa su credencial mínima de Auth en el adaptador de invitaciones, no en el verificador de tokens.

## Base de datos

`migrations/001_foundation.sql` crea roles sin login `llenamos_migrator` y `llenamos_app`, esquema,
identidades, restaurantes, miembros, locales, metadata administrativa, outbox, jobs e idempotencia.
Todas las tablas usan FORCE RLS. La API solo tiene SELECT sobre identidades/permisos y no puede
autoconcederse membresía. Outbox/jobs necesitan tenant seleccionado, miembro activo y no plataforma.
Son contratos iniciales, no un worker en funcionamiento ni sustituyen las reglas por operación.

Crear un login de ejecución sin privilegios, miembro de `llenamos_app`; custodiar su URI en archivo
privado montado mediante `DATABASE_URL_FILE`. La API rechaza roles superusuario/BYPASSRLS o dueños
de tablas. Nunca usar la conexión bootstrap para peticiones. Los métodos de repositorio deben
mantener SQL parametrizado; el contexto `app.*` se configura con `set_config(...,true)` dentro de
BEGIN y se limpia por COMMIT/ROLLBACK antes de devolver conexiones al pool.

Migraciones: ejecutar `pnpm --filter @llenamos/api migrate` con `MIGRATION_DATABASE_URL_FILE`
apuntando a una credencial bootstrap separada, capaz de crear roles y asignar propietario. Bloqueo
advisory, transacción por archivo y checksum para impedir editar migraciones ya aplicadas.
Esto debe ocurrir en una base vacía propia de Llenamos, nunca HQ ni otro servicio.
En la imagen compilada, usar `node dist/migrate.js` en un proceso separado con esa credencial;
el proceso HTTP no aplica migraciones ni necesita la credencial bootstrap.

La API no recibe UPDATE general de identidades/miembros: las invitaciones usan procedimientos
estrechos de la migración 003. La plataforma usa los de la 002 y mantiene auditoría/idempotencia.
Detalle y variables en [plataforma](src/platform/README.md). También faltan workers/claims de jobs, paginación de dominio,
archivos, realtime y paridad del producto. No se usa Redis ni se emula Firestore sobre JSON.

## Verificación

Desde el monorepo: `pnpm --filter @llenamos/api typecheck`, `test`, `build`.
Imagen desde la raíz: `docker build -f apps/api/Dockerfile -t llenamos-api:VERSION .`.
La imagen corre como usuario sin privilegios y solo incluye dependencias de producción, JS
compilado y migraciones; requiere el archivo de conexión runtime montado antes de arrancar.
Los contratos de core se compilan dentro del JS mediante tsup, sin ejecutar TypeScript en producción.
Las unitarias prueban proyecto equivocado, JWT sin firma, clave ajena, caducidad y sesión revocada.
Integración requiere Docker Linux: desde `apps/api`, `sh scripts/test-postgres-docker.sh` crea un
PostgreSQL temporal loopback, lo elimina al acabar y ejecuta las pruebas SQL/HTTP. No usa ni
modifica servicios de producción. Sin las variables de integración esas pruebas se omiten
explícitamente. No interpretar el test unitario solo como prueba de aislamiento PostgreSQL.
`sh apps/api/scripts/smoke-image-docker.sh llenamos-api:VERSION` prueba la imagen ya construida:
migración repetible, health/readiness, rechazo de Bearer inválido y usuario no root. Crea una
DB y red interna propias con una segunda red para el puerto HTTP loopback; no publica puertos SQL
y elimina sus contenedores, redes y volumen.

Referencias: [Firebase ID tokens](https://firebase.google.com/docs/auth/admin/verify-id-tokens),
[jose](https://github.com/panva/jose), [PostgreSQL RLS](https://www.postgresql.org/docs/18/ddl-rowsecurity.html).
