# Worker, avisos, webhooks, archivos y privacidad (V2)

Proceso aparte (`dist/worker-main.js`, mismo paquete que la API). Su login de PostgreSQL es miembro de
`llenamos_app` **y** de `llenamos_worker`; la API no puede serlo (lo comprueban `checkRuntimeRole` y
`checkWorkerRole`). `006_worker_files.sql` hace que `can_access_restaurant` acepte a `llenamos_worker`
cuando la transacción fija `app.restaurant_id`, de modo que las tablas de cualquier módulo funcionan
en el worker con su RLS normal, siempre acotadas a un restaurante. Lo único entre restaurantes son
funciones `SECURITY DEFINER` de `llenamos_worker_fn` (reclamar cola, abrir credenciales, listar ids). Solo el
worker puede abrir las credenciales completas. El receptor de webhooks tiene **otro** login (`llenamos_webhook`,
no miembro de `llenamos_app`): solo ejecuta `webhook_signing_secret` y `webhook_accept`, y lee los secretos de
firma guardados aparte (`integration_webhook_secrets`, otra clave derivada y AAD restaurante + proveedor, que la
plataforma escribe al guardar las APIs). Una inyección SQL en la API no puede leer credenciales ni anotar eventos.

## Cola con lease

- `enqueueOutbox` (avisos, efectos) y `enqueueJob` (`src/jobs.ts`, trabajos diferidos con clave de
  deduplicación) escriben en la misma transacción que el hecho. El ID es estable: repetir no duplica.
- El worker reclama con `FOR UPDATE SKIP LOCKED`, repartiendo por turnos entre restaurantes, como mucho tantos
  elementos como carriles (cada carril reclama de uno en uno), lease de 120 s renovado con latidos mientras el
  manejador trabaja, `ctx.signal` abortado al agotarse el tiempo o perder el lease y sin liberar el elemento hasta
  que el manejador termina de verdad. Antes de un efecto externo hay que llamar a `ctx.extendLease()` (falso =
  otro worker lo tiene: no hacer nada). Un tipo sin manejador espera sin gastar intentos (`Defer`), hasta 8 intentos con espera
  exponencial (30 s a 1 h con dispersión). Lease vencido se reintenta; al agotar intentos pasa a
  `quarantined`. Un resultado tardío con lease ajeno se descarta.
- Un manejador **debe ser idempotente** (puede entregarse dos veces). Lanzar `PermanentFailure(código)`
  termina en `failed`; `Quarantine(código)` en cuarentena; `RetryLater(segundos)` fija la espera; cualquier
  otro error reintenta. Un tipo sin manejador se reintenta (despliegue escalonado) y acaba en cuarentena.
- Los logs llevan id, tipo, restaurante, intento y código; nunca contenido ni destinatarios.

## Cómo engancha cada módulo

En su `ModuleDefinition` (`modules/types.ts`):

```ts
workerHandlers: [['reservas.recordatorio', async ctx => { /* ctx.tenant(client => …) */ }]],
marketingConsent: async (client, restaurantId, customerId, purpose) => boolean,
privacy: { subjectExists, exportData, blockers, erase },
```

- `ctx.tenant(fn)` abre una transacción del restaurante del elemento. **No hagas llamadas externas
  dentro**: primero decide en una transacción, llama al proveedor fuera y registra el resultado después
  con una clave estable (el ID del outbox) hacia el proveedor.
- `ctx.credentials()` devuelve las credenciales selladas del propio restaurante (vacías si no hay);
  jamás hay fallback a otro restaurante ni a variables globales.

## Avisos (`mensaje.enviar`)

`enqueueMessage(client, restaurantId, id, request)` (de `worker/index.ts`) valida la petición con
`MessageRequestSchema`, encola con `availableAt = sendAt` y deja la entrega en `message_deliveries`
(estados `sent`, `not_configured`, `failed`, `cancelled`). Correo (Resend, `Idempotency-Key` = ID del outbox) y
WhatsApp Cloud con credenciales del restaurante. Sin credenciales el elemento termina `failed` con
`not-configured` y la entrega queda `not_configured`: no hay captura ni éxito simulado. Rechazo definitivo
del proveedor (4xx) = `failed`; 429/5xx/red = reintento. Marketing (`purpose`) solo sale si algún módulo
declara `marketingConsent` y devuelve true; si no, la entrega queda `cancelled` (`sin-consentimiento`).
Límite conocido: si el proceso muere entre la respuesta de WhatsApp y el registro, el reintento puede
duplicar ese mensaje (WhatsApp Cloud no ofrece clave de idempotencia); con Resend no.

`procesarMensajesPendientes` ya no envía en la petición: adelanta los avisos futuros del restaurante y
devuelve el estado de las últimas 24 h.

## Webhooks

`POST /v1/webhooks/{stripe|whatsapp}/:restaurantId` (y `GET` de verificación de WhatsApp). Valida la firma
con las credenciales del restaurante (Stripe: `webhookSecret` o `mobileWebhookSecret`, ventana de 5 min;
WhatsApp: HMAC del cuerpo crudo), limita por proveedor y restaurante antes de abrir credenciales y anota el
evento una vez por `(restaurante, proveedor, id de evento)` (`webhook_events`). El cuerpo viaja por outbox
como `webhook.stripe` / `webhook.whatsapp`. Duplicados responden 200 sin repetir el efecto.

- Si ningún módulo atiende `webhook.stripe`, el receptor responde 503 (Stripe reintenta) sin anotar el evento.
  WhatsApp se valida contra el `phone_number_id` del restaurante y una ventana de 7 días por mensaje.
- V3 (señal) y V5 (cobros) registran su manejador de `webhook.stripe` (varios módulos pueden coincidir; cada
  uno atiende los `type` que le tocan y debe ser idempotente por `payload.eventId`).
- `webhook.whatsapp` lo atiende el worker: traduce botones/textos a un hecho `mensaje.respuesta`
  (`confirmed`, `cancelled`, `unsubscribe`) ligado al aviso y al mismo teléfono. La baja (`unsubscribe`) ya la cumple
  el worker (tabla `message_optouts` y cancelación del marketing en cola). V3 registra el manejador de
  `mensaje.respuesta` para cambiar la reserva; mientras no exista, esos hechos esperan (no se pierden).

Latido para el healthcheck: `/tmp/worker-heartbeat` (se escribe al sondear la cola).

## Archivos privados

Volumen `FILES_ROOT` (fuera de la raíz pública), `<restaurante>/<aa>/<id>`, modo 0600. Rutas:

- `PUT /v1/restaurants/:rid/files?purpose=…&name=…` (cuerpo binario, Bearer) → `201 {result:{id,…}}`.
- `GET|DELETE /v1/restaurants/:rid/files/:id` (Bearer).
- `GET /v1/public/files/:rid/:id` solo propósitos públicos (`carta_foto`), sin sesión ni listados.

Propósitos en `files/purposes.ts` (rol por permiso, tipos, tamaño; el contenido se comprueba por cabecera
mágica, no por lo que diga el cliente). Cuota por restaurante (512 MiB, 5000 archivos) serializada con un
bloqueo asesor. El borrado marca la fila y el worker retira los bytes (`archivo.borrar`); el mantenimiento
barre temporales y bytes huérfanos. Cliente web: `apps/web/src/lib/api/files.ts`.
Para añadir un propósito (p. ej. fotos de otra cosa) declara su entrada en `FILE_PURPOSES`.

## Privacidad

Operaciones de core `solicitarPrivacidad`, `verificarSolicitudPrivacidad`, `listarSolicitudesPrivacidad`,
`descargarExportacionPrivacidad`. La ejecución (`privacidad.procesar`) la hace el worker repartiendo entre
los `privacy` de los módulos más el de avisos. Requiere un `subjectExists` (módulo de clientes) y una
prueba de identidad vigente en `privacy_evidence` (la registra quien atiende a la persona). Exportación:
JSON cifrado (AES-256-GCM, clave derivada de la de integraciones) en el volumen, descargable con ticket de un
uso de 15 min **y** sesión, caduca a las 24 h. Borrado: bloquea si algún módulo declara servicio abierto;
si no, anonimiza, cancela avisos y deja una huella (`privacy_tombstones`) que la restauración respeta.
Cada módulo con datos personales declara `personalData` (sus tablas) y debe aportar `privacy`; si falta, las
solicitudes quedan `blocked` en vez de completarse. Pedir, verificar, listar y descargar exigen un miembro con el
permiso **sin restricción de locales**. Tras restaurar una copia, `restore_reapply_erasure` (SQL) vuelve a
solicitar el borrado de quien figure en el registro externo (`backup/ledger.sh`) y no esté ya borrado: el worker
debe procesarlo antes de reabrir la API.
Dependencias: `registrarConsentimiento` y el registro de pruebas de identidad pertenecen al módulo de
clientes/consentimientos (no están portados en este corte).

## Variables del worker

`DATABASE_URL_FILE` (login del worker), `PLATFORM_INTEGRATION_KEY_FILE`, `FILES_ROOT`, `WORKER_POLL_MS`,
`WORKER_CONCURRENCY`, `WORKER_HEARTBEAT_FILE`. La API necesita además `FILES_ROOT` (archivos), la clave de
integraciones (webhooks y exportaciones), `PUBLIC_APP_URL` (enlaces de descarga) y `WEBHOOK_DATABASE_URL_FILE`
(login `llenamos_webhook`; sin él no hay receptor de webhooks).
