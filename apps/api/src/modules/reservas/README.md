# Reservas en PostgreSQL (V3)

Migración `007_reservas.sql`. Cada documento conserva en `data jsonb` el JSON validado por los esquemas de
`@llenamos/core`; las columnas sueltas (`start_at`, `status`, `customer_id`, `reference`) existen para
consultar con índice y para unicidad. Todas las tablas llevan `restaurant_id`, RLS `FORCE`, dueño
`llenamos_migrator` y solo los GRANT mínimos a `llenamos_app`.

| Tabla | Contenido |
| --- | --- |
| `reservation_settings` | Configuración por local (`revision` crece en cada guardado) |
| `dining_areas`, `dining_tables` | Plano. Las usarán sala y carta (V4) |
| `customers` | Ficha por restaurante; estadísticas recalculadas en la transacción de cada cambio |
| `reservations` | Reserva con `manage_token_hash` (el token claro no se guarda), referencia única por restaurante |
| `waitlist` | Espera y oferta (`offer_token_hash`, `offer_expires_at`) |
| `reservation_origins`, `consents` | Origen y permisos de marketing de la reserva pública |
| `abuse_counters` | Solo accesible mediante `abuse_hit` (SECURITY DEFINER) |

## Operaciones (nombres y esquemas de core)

Públicas: `consultarDisponibilidad`, `crearReservaPublica`, `verReservaPublica`, `gestionarReservaPublica`,
`apuntarseListaEspera`, `aceptarOfertaListaEspera`, `iniciarPagoSenal`, `verRestaurantePublico` (nueva,
sustituye a `publicRestaurants/{slug}`).
Personal (rol y local desde SQL): `crearReserva`, `cambiarEstadoReserva`, `asignarMesas`, `moverReserva`,
`proponerMesasReserva` (`reservas.gestionar`), `guardarConfiguracionReservas` (`reservas.configurar`),
`importarReservas` (`reservas.importar`), `guardarPlano` (`plano.editar`) y `editarCliente` (`clientes.editar`).
`guardarPlano`, `editarCliente` y `verRestaurantePublico` son contratos nuevos en
`packages/core/src/api-reservas-vps.ts` (sustituyen escrituras y lecturas directas del navegador).

Fuera de este módulo: `cambiarPlan` (lo cubre `configurarRestauranteLogiqd` de plataforma) y
`procesarMensajesPendientes` (worker de V2).

## Sin sobreventa

Toda escritura que cambia el aforo toma `pg_advisory_xact_lock` del local y recalcula disponibilidad con
el motor de core sobre las reservas de ±48 h (índice `(restaurante, local, start_at)`). Dos peticiones no
pueden ver el mismo hueco libre. La reserva se lee `FOR UPDATE` antes de cambiarla. Las ofertas vigentes de
la lista de espera cuentan como ocupadas hasta caducar.

## Ámbito público y credenciales

Las operaciones públicas no tienen identidad: la API resuelve el slug con `reservas_public_resolve`
(SECURITY DEFINER, solo datos mínimos) y abre una transacción con `app.public_restaurant`, que habilita las
políticas `public_scope` de estas tablas y la inserción en `outbox`, `events` y `jobs` de ese restaurante
únicamente. Referencia + token del enlace se validan con `reservas_link_lookup` **antes** de cargar contexto;
fallos contados por IP y por referencia.

## Antiabuso

Orden: límite en memoria por IP → resolver slug → módulo activo → límites persistentes → transacción.
- Por IP y restaurante (`abuse_hit`, en su propia transacción: también cuenta lo rechazado).
- Por restaurante y por destinatario: se **comprueban** antes (`abuse_count`, sin sumar) y se **suman dentro de la
  transacción** de la reserva, ya validada la franja y antes de encolar avisos; si falla, la cuenta se revierte. Así
  intentos rechazados no gastan el cupo de un teléfono ajeno. Creación y espera usan claves distintas
  (`recipient-create`, `recipient-waitlist`).
- Enlaces: 60/10 min por IP; 15 fallos/10 min por IP y 10 fallos/h por referencia. El bloqueo se comprueba **antes**
  de mirar el token: con el límite superado ni el token correcto entra. Contrapartida conocida: quien conozca una
  referencia puede bloquear su enlace una hora con 10 fallos (la referencia viaja en el correo; el token no).
- Valores en `abuse.ts` (`limits`). Campo trampa `website`; duplicado exacto → 409.
- `verRestaurantePublico`: 1200/10 min por IP en memoria (la lee también el servidor de Next).

IP verificada (`client-ip.ts`): solo se usa la cabecera de `TRUSTED_IP_HEADER` si la conexión llega de una IP de
`TRUSTED_PROXY_ADDRESSES`. En el despliegue: `x-real-ip` (la reescribe nginx con la IP real tras el túnel) y
`172.30.43.3`, la IP fija del gateway en la red `application` (`compose.yaml`). Con `NODE_ENV=production` la API no
arranca sin ambas variables (`config.ts`): sin ellas todos los visitantes compartirían la IP del gateway.
IPv6 se agrupa por /64.

## Avisos, eventos y trabajos

- `outbox`, tipo `aviso.mensaje`, payload = `MessageRequest` de core; ID estable derivado del hecho.
  Contiene el enlace de gestión con el token claro: **el worker de V2 debe quitar `data.manageUrl` y
  `data.offerUrl` del payload tras enviar** (al cancelar, `reservas_cancel_notices` ya los borra). La futura lectura
  `mensajesReserva` no debe devolver esas URL. Por HTTP solo owner y manager leen los avisos de `outbox`
  (política RESTRICTIVE `reservas_notice_roles`; el worker, sin actor, no se ve afectado).
  Los pendientes de una reserva se pasan a `cancelled` (la migración añade ese estado a la restricción).
- Eventos `reservas.reserva`, `reservas.espera`, `reservas.ajustes`, `reservas.plano`, `reservas.cliente`
  sin datos personales.
- Trabajo `reservas.caducar_oferta` (uno por oferta, `scheduled_at` = caducidad): **ya es un manejador del worker**
  (`worker.ts`), más una red de seguridad programada cada 5 minutos (`reservasMaintenance`, enlazada en `worker-main.ts`).
- Señal: `webhook.stripe` **ya confirma la señal** (`stripeDepositHandler`, `worker.ts`): el evento `checkout.session.completed`
  pagado con `metadata.kind=reservation_deposit`, `reservationId` y `locationId` llama a `applyDepositPayment`; el
  restaurante sale del evento firmado, no de los metadatos. Un pago que no cuadra (importe, moneda o sesión) va a
  cuarentena `senal-no-corresponde`. `iniciarPagoSenal` crea la sesión de Checkout
  con la Stripe **del restaurante** (W3, `payments/deposit.ts`): la API abre su clave sellada solo para esa petición pública
  (función SQL `payments_stripe_ciphertext`, que solo responde con el ámbito público de ese restaurante), reutiliza la sesión
  abierta si la hay, comprueba que la respuesta de Stripe cuadra (importe, moneda, metadatos y modo) y la guarda con
  `recordCheckoutSession`. Sin clave del restaurante responde `not_configured`; nunca se usa otra clave.
- Los `metadata.reservationPath` del Stripe de Firebase se **ignoran a propósito** (solo vale `kind=reservation_deposit`). Una señal sobre una reserva ya cancelada se anota pagada sin resucitarla y va a cuarentena `senal-reserva-cancelada` para devolverla a mano; sin reserva/local/servicio, `senal-sin-reserva` / `senal-sin-servicio`.
- Privacidad (`privacy.ts`): el sustituto de la persona es aleatorio por borrado, la ficha de `customers` se borra (el worker tiene `DELETE` solo ahí) y se limpian los hechos `mensaje.respuesta` / `webhook.whatsapp` con su teléfono y texto. El núcleo (`privacy/known.ts`) bloquea exportar y borrar si hay filas en tablas de campañas o fidelización sin contribuidor que las declare.
- `mensaje.respuesta` (`reservationReplyHandler`): «confirmo» o «cancelar» (texto o botón) desde el **mismo teléfono** de la
  reserva y citando su aviso confirma o cancela la reserva; si ya no admite el cambio no hace nada.

## Lecturas en vivo (`liveQueries`)

`reservasDia`, `ajustesReservas`, `listaEsperaDia`, `plano`, `clientes`, `cliente`, `reservasCliente`, con sus
temas. Respetan el local asignado al miembro. Pendiente de V1 que `useLiveQuery` las sirva.

## Sala (V4): ocupación y ganchos (cableado en V11)

`registerOccupancySource(nombre, fuente)` (`engine.ts`) añade al aforo las mesas ocupadas sin reserva (sesiones de
mesa) y declara qué reservas sentadas ya representa una sesión. **Sala la registra al cargarse** (`sala/occupancy.ts`,
fuente `sala`) con la función SQL `reservas_open_sessions`, que sirve también al ámbito público; la prueba de punta a
punta está en `sala/cableado-reservas-sala.integration.test.ts` (reservas no vende una mesa sentada y sala no abre una
reservada).

`reservationHooks` (`staff.ts`): sala los registra (`sala/hooks-reservas.ts`). `onSeated` abre la sesión de mesa,
`onFinished` la cierra con los requisitos de servicio y caja, y `assertAssignable` rechaza reasignar mesas con la cuenta
en cobro. Orden de bloqueos: reservas, sala y caja (caja en compartido).

## Origen, estado final y eventos de plataforma

- El origen de cada reserva (web, personal, lista de espera) se guarda con `recordReservationOrigin` de campañas (canal,
  campaña, día de servicio y comensales como columnas) y su estado final con `updateOriginOutcome`; el personal pasa por
  ahí y las rutas públicas (gestión por enlace, señal pagada) por la función `reservas_origin_outcome`, que solo toca ese
  campo. La política de lectura pública de orígenes solo ve la fila que la misma transacción acaba de crear. Las ventas
  cobradas de la reserva las pone caja al saldar o devolver.
- `reservation.created` (crear, importar, aceptar oferta de espera) y `reservation.statusChanged` (cambio de estado, también
  por enlace público y por señal pagada) llaman a `enqueuePlatformEvent` en la misma transacción con id determinista
  (`reservationPlatformEvent` en `store.ts`).
- `readWindow` acota por `start_at` (rango total y ventana de cada instante, `READ_WINDOW_SQL`); el índice por local y día
  lo prueba un `EXPLAIN` con un histórico de 6000 filas.
- `guardarPlano` rechaza borrar una mesa con sesión de sala abierta o con la cuenta pedida.

## Notas

- La política `reservas_public_outbox_read` (`occurred_at=now()`) es necesaria: `INSERT ... ON CONFLICT DO NOTHING` en
  `outbox` comprueba también la política de lectura de la fila nueva; sin ella el alta pública falla.
- `clientes` pagina por cursor `(nombre, id)` con el índice `customers_name`; la búsqueda por texto usa `ILIKE` sobre
  el documento sin índice trigram (requeriría `pg_trgm`): queda como mejora si el volumen lo pide.
- La oferta de espera y la caducidad no actúan si el módulo de reservas está apagado.


