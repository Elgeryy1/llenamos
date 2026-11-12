# Backend de fase 0

Todo se ejecuta con el proyecto local `demo-llenamos`, sin login ni despliegue.

```powershell
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-21.0.13.21-hotspot'
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
pnpm --filter functions typecheck
pnpm --filter functions lint
pnpm --filter functions test
pnpm funciones:build
pnpm test:reglas
```

Las pruebas normales cubren permisos y actividad sin necesitar emuladores. La suite de integración usa Auth y Firestore y se habilita expresamente:

```powershell
$env:TEST_FIREBASE_EMULATORS='1'
$env:GCLOUD_PROJECT='demo-llenamos'
pnpm exec firebase emulators:exec --project demo-llenamos --only 'auth,firestore,functions,storage' "pnpm --filter functions test && pnpm exec tsx scripts/check-seed.ts"
```

Este último comando comprueba las cuatro callables, arranca los disparadores y ejecuta el seed dos veces. `check-seed.ts` verifica que siguen los mismos 32 documentos, conservando fechas, seis cuentas y dieciséis mesas sin solapes dentro del plano 0–100, plazas de 2/4/6/8, ambas formas, parejas y tríos con uniones simétricas en su zona, una mesa deshabilitada en Terraza y nombres personales coherentes con Auth. La integración verifica además la actividad con autor sin duplicados y la reactivación. Los emuladores se detienen al terminar. El seed conserva `FIRESTORE_EMULATOR_HOST` y `FIREBASE_AUTH_EMULATOR_HOST` si ya están definidas.

Las membresías y el índice de restaurantes de cada usuario cambian en una sola transacción. Los cambios concurrentes se serializan con el documento del restaurante. Una invitación a un correo existente añade una membresía sin cambiar su contraseña; una membresía activa devuelve `already-exists`. Si está inactiva, la reactiva con el rol pedido, conserva su fecha de creación y acceso a locales y repone `users/{uid}.restaurants`, respetando los permisos sobre el rol anterior y los roles asignables. Si Auth crea la cuenta pero la transacción falla, puede quedar la cuenta sin membresía; reintentar reutiliza esa cuenta.

Las callables guardan actividad con uid, nombre del autor y resumen en castellano en la misma transacción que la operación: `restaurant.created`, `member.invited`, `member.reactivated`, `member.roleChanged` y `member.deactivated`. Crear restaurante registra también el alta del propietario. El campo de servidor `changeId` señala esa entrada y los disparadores omiten el evento si aparece o cambia. Los cambios posteriores del cliente conservan su actividad con autor. El resto de eventos usa su identificador como clave para evitar duplicados; se omiten cambios exclusivos de fechas. El seed mantiene actividad con actor nulo.

CI usa Node 22 y Java 21 y ejecuta `pnpm verificar`. Sus comprobaciones de web y core dependen de las ramas de los otros agentes.

Las escrituras de cliente en ajustes, locales, zonas y mesas requieren `updatedBy` igual al uid de la sesión. Actividad prioriza el contexto de usuario del evento y usa ese campo como alternativa cuando el emulador omite el contexto. En borrados sin contexto se usa el último editor del documento, no necesariamente quien lo borra. La integración incluye un cambio de ajustes mediante el SDK cliente autenticado y comprueba uid y nombre en la actividad.

## R2: mensajes, lista de espera y señal

Los proveedores se llaman con `fetch`, sin SDK ni dependencias nuevas. Variables del servidor:

| Variable | Uso |
| --- | --- |
| `RESEND_API_KEY`, `EMAIL_FROM` | Correo transaccional mediante Resend |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Envío por WhatsApp Cloud API (Graph v23.0) |
| `WHATSAPP_VERIFY_TOKEN` | Verificación GET del webhook de Meta |
| `WHATSAPP_APP_SECRET` | HMAC SHA-256 de los bytes originales del webhook de Meta |
| `STRIPE_SECRET_KEY` | Crear Checkout por el importe guardado en la reserva, EUR |
| `STRIPE_WEBHOOK_SECRET` | Firma de Stripe sobre timestamp y cuerpo original, tolerancia 5 minutos |
| `PUBLIC_APP_URL` | Origen de la web para enlaces; HTTPS obligatorio para Checkout; en local los mensajes usan `http://localhost:3000` |

No poner secretos en Git. Sin las credenciales completas del canal, se guarda `captured` solo cuando `FUNCTIONS_EMULATOR=true`; fuera se guarda `not_configured`. Nunca `sent` sin respuesta correcta con identificador del proveedor. La bandeja guarda asunto y cuerpo. Las respuestas a botones usan el mensaje de origen y comprueban teléfono y reserva. El texto libre necesita el contexto del mensaje respondido; no se adivina qué reserva cancelar.

Stripe y WhatsApp **no se han probado contra los servicios reales**. Tampoco se ha enviado correo real. WhatsApp usa texto y botones interactivos: Meta exige ventana de atención abierta para estos envíos; para iniciar conversaciones fuera de esa ventana habrá que registrar y mapear plantillas aprobadas en Meta antes de producción. Un rechazo del proveedor queda `failed`.

`mensajeCreado` procesa mensajes vencidos; `mensajesProgramados` procesa cada cinco minutos y caduca ofertas. En emuladores, ejecutar la callable `procesarMensajesPendientes` (owner/manager con `mensajes.ver`, o claim `logiqd`). Script local:

```powershell
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9103'
$env:FUNCTIONS_EMULATOR_HOST='127.0.0.1:5013'
$env:MENSAJES_EMAIL='propietario@lumbre.test'
$env:MENSAJES_PASSWORD='Llenamos2026!'
pnpm mensajes:procesar demo-lumbre
```

El bloqueo de envío dura 60 segundos y los fetch tienen un máximo de 15 segundos. Resend recibe una clave de idempotencia estable. WhatsApp no ofrece aquí idempotencia: si el proceso cae después del envío y antes de guardar la respuesta, podría duplicarse al recuperar el bloqueo; no se promete entrega exactamente una vez. Los fallos quedan para revisión, sin reenvío automático que pudiera duplicar un envío ambiguo.

### Integración con R1 y R5

R1 mantiene `messages/enqueue.ts`; R2 no lo modifica. Se procesan sus documentos con el contrato de core. Datos de plantillas: `guestName`, `restaurantName`, `partySize`, `startAt` (ms), `timezone`, `reference`, `manageUrl`, `offerUrl`, `paymentUrl`, `googleReviewUrl`. También se admite `date`/`time` si R1 ya los calcula. Solo el mensaje lleva el token sin hash dentro del enlace; los documentos de reserva y oferta guardan únicamente su hash.

R1 y R2 ya incluyen las ofertas activas en sus comprobaciones transaccionales de disponibilidad: leen `locations/{lid}/waitlist` y suman `offeredOccupancy(id, entry, settings, now)` a las ocupaciones. Comparten el bloqueo de reservas. La integración comprueba que una reserva pública no puede consumir el hueco ofertado y que aceptar excluye solo la oferta propia.

R5 debe atender `/r/[slug]/lista-espera/[waitlistId]?t=...` y llamar a `aceptarOfertaListaEspera`; se devuelve el mismo contrato que `crearReservaPublica`. El estado inicial respeta `autoConfirm` y la señal. R1 crea/actualiza la ficha de cliente mediante su disparador de reservas. Las reglas de R1 deben mantener cerradas las colecciones internas `r2RateLimits` y `r2WebhookEvents`.

La firma Stripe no basta: también se comprueban sesión guardada, pago completo, moneda e importe. Los eventos repetidos son inocuos; un pago tardío de una reserva cancelada se registra sin reabrirla y requiere revisión manual (no hay reembolsos automáticos).

### Pruebas locales aisladas

La suite `src/messages/r2.integration.test.ts` exige `TEST_R2_EMULATORS=1`, proyecto `demo-llenamos` y Firestore `127.0.0.1:8097`. Usa Functions en 5013 y secretos ficticios `r2-local-test` para los dos webhooks, nunca credenciales reales. Configurar `.env.local` de functions con `WHATSAPP_APP_SECRET=r2-local-test` y `STRIPE_WEBHOOK_SECRET=r2-local-test`; la config de emuladores es temporal y no versionada. Ejecutar con `firebase emulators:exec --config firebase.r2.local.json --project demo-llenamos --only auth,firestore,functions,storage "pnpm --filter functions exec vitest run src/messages/r2.integration.test.ts"`. Ese comando apaga únicamente los emuladores que arranca.

Validación inicial de R2: tipos, lint y build de functions; 66 pruebas unitarias de functions, 243 de core y 2 pruebas de integración R2 con todos los recorridos anteriores. Los emuladores usaron Node 24 del equipo (el build apunta a Node 22) y Java 21; queda pendiente repetir con el runtime Node 22 antes de desplegar.

La validación ampliada de P, con la lista de espera completa, Checkout simulado y cargas HTTP firmadas de Stripe, está en [`docs/tareas/fase1-pendientes-validacion.md`](../docs/tareas/fase1-pendientes-validacion.md). Incluye los comandos vigentes con `firebase.agente2.json`, 86 pruebas de funciones habilitando todas las integraciones y la prueba de navegador.
