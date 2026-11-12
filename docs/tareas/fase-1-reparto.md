# Fase 1 · Llenamos Reservas · reparto entre agentes

Objetivo: el producto con el que se sale a vender. Un restaurante configura sus horarios y su plano, comparte un enlace, los clientes reservan solos, el personal ve el día y el plano en directo, los avisos salen solos y el restaurante recibe reseñas.

Todo **en local** con los emuladores (`demo-llenamos`). Nada en la nube, sin cuentas nuevas ni gastos. Lo que necesita un proveedor externo (correo, WhatsApp, Stripe) se programa detrás de variables de entorno: **sin claves, no se envía nada** y la interfaz lo dice («no configurado»). En local los mensajes quedan **capturados** en una bandeja visible en el panel, marcados como «no enviado: modo local».

El contrato de datos y funciones de esta fase está en `ARQUITECTURA.md`, sección **«Fase 1»**. Es la referencia común: si algo de aquí y de allí no cuadra, manda `ARQUITECTURA.md`. Quien cambie el contrato lo actualiza en el mismo commit y lo dice en su informe.

## Orden

1. **R0 · Contrato en core** (un agente, primero). Esquemas, adaptadores al motor, módulos y planes, permisos nuevos y plantillas de entrada y salida de las funciones. Todo lo demás parte de aquí.
2. En paralelo, cada uno en su worktree y su rama, partiendo de `main` con R0 ya fusionado:
   - **R1 · Backend de reservas** (`fase1/backend-reservas`)
   - **R2 · Mensajes, lista de espera y señal** (`fase1/mensajes`)
   - **R3 · Panel: el día** (`fase1/panel-dia`)
   - **R4 · Panel: configuración** (`fase1/panel-config`)
   - **R5 · Web pública de reservas** (`fase1/publica`)
3. Integración (coordinador): fusionar en el orden R1, R2, R4, R3, R5; arrancar todo; probar el recorrido completo; capturas y registro en `PLAN.md`.

## Puertos para no chocar

Los emuladores del coordinador usan los del contrato (9099, 8085, 5001, 9199, UI 4001) y la web el 3000: **no se paran ni se tocan**. Cada agente usa una config temporal **no versionada** (excluida en `.git/info/exclude`) con estos puertos, y su web (si la tiene) en el suyo:

| Agente | Auth | Firestore | Functions | Storage | UI | Hub | Logging | Eventarc | Tasks | Web |
|---|---|---|---|---|---|---|---|---|---|---|
| R1 | 9102 | 8096 | 5012 | 9212 | 4011 | 4411 | 4511 | 9311 | 9511 | — |
| R2 | 9103 | 8097 | 5013 | 9213 | 4012 | 4412 | 4512 | 9312 | 9512 | — |
| D (base de componentes) | 9104 | 8098 | 5014 | 9214 | 4013 | 4413 | 4513 | 9313 | 9513 | 3011 |
| R3 | 9107 | 8101 | 5017 | 9217 | 4016 | 4416 | 4516 | 9316 | 9516 | 3014 |
| R4 | 9105 | 8099 | 5015 | 9215 | 4014 | 4414 | 4514 | 9314 | 9514 | 3012 |
| R5 | 9106 | 8100 | 5016 | 9216 | 4015 | 4415 | 4515 | 9315 | 9515 | 3013 |

La web lee los puertos de `NEXT_PUBLIC_*_EMULATOR_PORT` (ver `.env.example`); el seed y las pruebas, de `FIRESTORE_EMULATOR_HOST` y `FIREBASE_AUTH_EMULATOR_HOST`. Para las pruebas de reglas con otro puerto: `firebase emulators:exec --config <config> --only firestore "vitest run --root tests/rules"`. Nadie mata procesos que no haya arrancado.

## Reglas comunes

- Leer antes `ARQUITECTURA.md` entero, `PLAN.md` y este archivo. Quien toque `apps/web`, también `apps/web/AGENTS.md` y las guías de `apps/web/node_modules/next/dist/docs/` que apliquen (Next 16.4).
- TypeScript estricto, textos y comentarios en castellano, interfaz con el diseño del contrato (sin guiones dentro de las frases, sin Title Case).
- **Sin dependencias nuevas** salvo que se diga en el encargo. Stripe, WhatsApp y el correo se llaman con `fetch`.
- Dinero en céntimos enteros. Teléfonos en E.164 (`+34…` por defecto).
- Cada escritura de cliente en Firestore lleva `updatedBy` (lo comprueban las reglas).
- Commits en castellano con autor `Elgeryy1 <noreply@logiqd.me>` usando `git -c user.name=Elgeryy1 -c user.email=noreply@logiqd.me commit …` (sin tocar la configuración global). Push de la rama, **sin PR**.
- Informe final corto: qué se ha hecho, cómo probarlo, comprobaciones, dependencias, supuestos sobre lo de otros agentes, pendiente y SHA.

---

## R0 · Contrato en core · `fase1/contrato`

Carpeta: `packages/core/src/` (y `ARQUITECTURA.md` si hay que precisar algo).

1. **Esquemas de Firestore en inglés** (`model.ts` o archivos nuevos en `src/`), exactamente como la sección «Fase 1» de `ARQUITECTURA.md`: `ReservationSettings`, `Reservation`, `Customer`, `WaitlistEntry`, `Message`, `PublicRestaurant`, y los campos nuevos del restaurante (`plan`, `moduleOverrides`, `activeModules`).
2. **Adaptadores al motor** (el motor sigue en castellano y no se reescribe): `settingsToConfiguracion(settings)`, `reservationToOcupacion(id, reservation)` y lo que haga falta para que las funciones y la web usen el motor con los documentos guardados. Pruebas que demuestren que el motor da el mismo resultado leyendo documentos.
3. **Módulos y planes** (`modules.ts`): `MODULES`, `MODULE_LABEL`, `PLANS` (provisionales, sin precio), `activeModulesFor(plan, overrides)`, `hasModule(restaurant, module)`.
4. **Permisos nuevos** en `roles.ts` (tabla del contrato) con sus pruebas.
5. **Entradas y salidas de las funciones** (`api.ts`): un esquema zod por callable de la tabla del contrato, para que web y funciones validen lo mismo.
6. **Utilidades**: `normalizePhone(raw, defaultCountry = "34")` → E.164 o error; `customerIdFor(restaurantId, phoneE164)` (hash corto estable, sin dependencias de Node: implementa un hash puro o recibe la función de hash como parámetro); `reservationReference(bytes)` → código de 6 caracteres sin letras confusas.
7. Pruebas de todo con Vitest. Comprobación: `pnpm --filter @llenamos/core typecheck && pnpm --filter @llenamos/core lint && pnpm --filter @llenamos/core test`.

---

## R1 · Backend de reservas · `fase1/backend-reservas`

Carpetas: `firebase/`, `functions/`, `tests/rules/`, `scripts/`.

1. **Reglas** de todas las rutas nuevas (tabla del contrato), con el módulo `reservations` activo como condición para leer reservas, clientes y lista de espera. Pruebas de reglas a favor y en contra.
2. **Callables de reservas** (tabla del contrato, salvo las de R2): `consultarDisponibilidad`, `crearReservaPublica`, `verReservaPublica`, `gestionarReservaPublica`, `crearReserva`, `cambiarEstadoReserva`, `asignarMesas`, `moverReserva`, `proponerMesasReserva`, `guardarConfiguracionReservas`, `importarReservas`, `cambiarPlan`. Todas usan el motor de core dentro de una transacción para no vender dos veces la misma mesa o franja.
3. Al crear o cambiar una reserva, **encolar los mensajes** (documentos `messages` con `status: "queued"`) en la misma transacción, con la función `enqueueMessage(tx, …)` del contrato (confirmación, recordatorio del día antes con `sendAt`, cancelación). Enviar no es cosa de R1: lo hace R2.
4. **Disparadores**: actividad de reservas (`reservation.created`, `reservation.statusChanged`…), ficha de cliente (crear o actualizar visitas, no presentados y cancelaciones), y sincronización de `publicRestaurants/{slug}`.
5. **Equipo de LogiQD**: el claim `logiqd: true` permite `cambiarPlan`. Script `pnpm logiqd:equipo <correo>` que pone el claim en el emulador.
6. **Seed** ampliado e idempotente: plan `sala`, configuración de reservas de Taberna Lumbre (comida 13:00–15:30 y cena 20:00–22:30 de martes a sábado, domingo solo comida, lunes cerrado), reservas de ejemplo para hoy y mañana en varios estados (las fechas se calculan al ejecutar), algunos clientes con notas y alergias, una entrada en lista de espera y la cuenta `equipo@logiqd.test` («Equipo LogiQD», misma contraseña) con el claim.
7. Pruebas: unitarias y de integración contra emuladores (crear reserva pública, doble reserva de la misma mesa rechazada, cambio de estado, importación con filas erróneas, permisos por rol y por módulo).

Comprobación: `pnpm --filter functions typecheck && pnpm --filter functions lint && pnpm --filter functions test && pnpm funciones:build`, pruebas de reglas, integración y seed dos veces.

---

## R2 · Mensajes, lista de espera y señal · `fase1/mensajes`

Carpetas: `functions/` (archivos propios, sin tocar los de R1 salvo `index.ts` para exportar), `packages/core/src/mensajes/` (plantillas puras), `tests/rules/` solo si añade algo.

1. **Plantillas** en core (`mensajes/`): confirmación, recordatorio, cancelación, oferta de lista de espera, petición de señal y petición de reseña, en castellano, catalán e inglés, para correo (asunto y cuerpo) y WhatsApp (texto corto con botones «Confirmo» y «Cancelar» cuando aplique).
2. **Procesador** de `messages`: al crearse un mensaje con `sendAt` vencido y cada 5 minutos (`onSchedule`) para los programados. Como el planificador no corre en el emulador, también la callable `procesarMensajesPendientes` y el script `pnpm mensajes:procesar`.
3. **Proveedores** por `fetch`: correo con Resend (`RESEND_API_KEY`, `EMAIL_FROM`) y WhatsApp Cloud API (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`). Sin claves: en el emulador `status: "captured"` con el texto ya renderizado; fuera del emulador `status: "not_configured"`. Nunca se finge un envío.
4. **Respuestas por WhatsApp**: función HTTP `whatsappWebhook` (verificación con `WHATSAPP_VERIFY_TOKEN` y firma `X-Hub-Signature-256` con `WHATSAPP_APP_SECRET`); «Confirmo» confirma y «Cancelar» cancela la reserva. Pruebas con cargas de ejemplo.
5. **Recordatorios y reseñas**: si una reserva se cancela o se mueve, se anulan o reprograman sus mensajes pendientes. Al pasar a `finished`, si la configuración tiene `reviews.enabled` y `googleReviewUrl`, se encola la petición de reseña para el día siguiente a las 12:00 del local.
6. **Lista de espera**: callables `apuntarseListaEspera` y `aceptarOfertaListaEspera`. Cuando se libera sitio (cancelación o no presentado), se ofrece la franja a la primera entrada compatible, con un enlace que guarda el hueco `waitlist.offerMinutes` minutos.
7. **Señal con Stripe**: si la configuración pide señal y hay `STRIPE_SECRET_KEY`, `crearReservaPublica` (de R1) deja la reserva en `pending` con `deposit.status: "required"`; la callable `iniciarPagoSenal` crea una sesión de Stripe Checkout por `fetch` y devuelve la URL; la función HTTP `stripeWebhook` verifica la firma (`STRIPE_WEBHOOK_SECRET`, HMAC sin SDK) y con `checkout.session.completed` marca `deposit.status: "paid"` y confirma. Sin claves: `deposit.status: "not_configured"` y la web lo dice. Pruebas de la firma y del flujo con cargas de ejemplo; anota que no se ha probado contra Stripe real.

Comprobación: la de functions y core, más integración contra emuladores (mensaje capturado al crear una reserva, recordatorio programado, webhook de WhatsApp que cancela, oferta de lista de espera al cancelar).

---

## R3 · Panel: el día · `fase1/panel-dia`

Carpeta: `apps/web/` (páginas propias; en `lib/panel/nav.ts` solo añade sus entradas).

1. **Reservas** (`/panel/reservas`): el día elegido agrupado por turnos, en directo; filtros por estado; acciones según el estado (confirmar, sentar, terminar, cancelar, no presentado) con `cambiarEstadoReserva`; nueva reserva por teléfono o en el local (`crearReserva`, con las horas libres de `consultarDisponibilidad` o calculadas con el motor); mover; **asignar mesa** con las propuestas de `proponerMesasReserva` y su explicación, para que decida el encargado.
2. **Sala en directo**: el plano de `/panel/sala` muestra en cada mesa su reserva de ahora o la siguiente (libre, reservada, sentados) y al pulsar una mesa se ve la reserva.
3. **Clientes** (`/panel/clientes`): buscar por nombre o teléfono, ficha con visitas, no presentados, cancelaciones, notas y alergias (editables por quien tenga permiso).
4. **Lista de espera** (`/panel/lista-espera`): entradas del día y su estado.
5. **Importar** (`/panel/importar`): subir un CSV (o el CSV que guarda Excel; `.xlsx` solo si cabe sin dependencia pesada, y dilo), ver la vista previa con errores por fila y enviar con `importarReservas`.
6. Todo oculto si el módulo `reservations` no está activo (y la página lo explica).
7. Pruebas con Vitest de la lógica y componentes clave.

Comprobación: `pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web test && pnpm --filter web build`.

---

## R4 · Panel: configuración · `fase1/panel-config`

Carpeta: `apps/web/` (páginas propias; en `lib/panel/nav.ts` solo añade sus entradas).

1. **Editor del plano** (`/panel/plano`): crear, mover (arrastrar), redimensionar, girar entre redonda y rectangular, deshabilitar y borrar mesas; crear y ordenar zonas; marcar qué mesas se pueden unir (simétrico). Escribe en Firestore con `updatedBy`. Funciona con ratón y táctil.
2. **Horarios y reservas** (`/panel/horarios`): turnos de cada día, excepciones, cierres, duración por tamaño de grupo, margen, capacidad, antelación, tamaños de grupo, reservas por la web sí o no, confirmación automática, señal, cancelación gratuita hasta X horas, recordatorio del día antes, petición de reseña con el enlace de Google y lista de espera. Guarda con `guardarConfiguracionReservas`.
3. **Mensajes** (`/panel/mensajes`): bandeja de lo enviado, capturado en local, no configurado o fallido, con el texto tal cual le llegaría al cliente; botón «Procesar pendientes» (`procesarMensajesPendientes`).
4. **Compartir** (`/panel/compartir`): enlace público, código del widget para la web del restaurante, y cómo ponerlo en Instagram y en Google Maps.
5. **Módulos**: el menú del panel oculta lo que no está en `activeModules`; Ajustes enseña el plan y los módulos (solo lectura). Página interna **`/logiqd`** para quien tenga el claim `logiqd`: lista de restaurantes, plan y módulos, con `cambiarPlan`.
6. Pruebas con Vitest.

Comprobación: la de web.

---

## R5 · Web pública de reservas · `fase1/publica`

Carpeta: `apps/web/` (rutas públicas propias, fuera de `(personal)`; en `public/` el script del widget).

1. **Página de reservas** `/r/[slug]`: con la marca del restaurante (color, nombre, locales). Pasos: local (si hay varios), fecha, personas, hora (de `consultarDisponibilidad`), datos (nombre, teléfono, correo opcional, notas), aceptar la política, confirmar (`crearReservaPublica`). Si pide señal: pagar (`iniciarPagoSenal`) o, sin Stripe configurado, explicar que la reserva queda pendiente y el restaurante contactará.
2. **Gestionar la reserva** `/r/[slug]/reserva/[ref]?t=…`: ver, confirmar o cancelar (`verReservaPublica`, `gestionarReservaPublica`).
3. **Lista de espera**: si no hay hora, apuntarse (`apuntarseListaEspera`); aceptar una oferta desde el enlace (`aceptarOfertaListaEspera`).
4. **Widget**: `/widget/[slug]` (la misma reserva en formato compacto para un iframe) y `public/widget.js`, que el restaurante pega en su web y abre la reserva en un iframe o una ventana. Enlace corto para la bio de Instagram y el botón «Reservar» de Google Maps (es el mismo enlace).
5. **Idiomas**: castellano, catalán e inglés, por el `locale` del restaurante y un selector.
6. Si el restaurante no existe, no tiene el módulo de reservas o no acepta reservas por la web, se dice claramente.
7. Accesible, rápida y pensada para móvil. Metadatos para compartir (título, descripción, imagen).
8. Pruebas con Vitest.

Comprobación: la de web.
