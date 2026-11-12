# Módulo sala (V4): carta, QR, mesas, comandas, cocina, barra y recogida

Migraciones `008_sala_cocina.sql` y `009_sala_caja.sql` (esta última va después de `009_caja.sql` por nombre). Registrado con una línea en `modules/index.ts`.

## Qué hay

- **34 operaciones** del contrato `CALLABLES_FASE2` de `@llenamos/core` (mismos nombres, entradas y
  salidas que usa la web) más `verCartaPublica` (pública, sustituye al documento `publicMenus`; su
  esquema es `PublicMenuSchema`). Las 6 de `FASE2_ACCESS = public` (`verMesaPublica`, `pedirDesdeMesa`,
  `avisarDesdeMesa`, `consultarRecogida`, `pedirParaLlevar`, `verParaLlevarPublico`) no llevan sesión.
- **4 lecturas en vivo** (`live.ts`, esquemas en `@llenamos/core` `sala/vivo.ts`): `salaServicio`, `salaHistorial`
  (mesas abiertas, sus pedidos y líneas, tareas activas, recogidas vigentes), `salaCarta` (carta,
  estaciones, ajustes) y `cocinaLineas` (líneas visibles de una estación). Temas de evento:
  `sala.sesion`, `sala.pedido`, `sala.linea`, `sala.tarea`, `sala.recogida`, `carta.categoria`,
  `carta.plato`, `carta.menu`, `cocina.estacion`, `sala.ajustes`, `sala.qr`.
- La lógica de negocio (precios, fuego de pases, planes de mesas, estados) es la misma de
  `@llenamos/core`; `service.ts`, `orders.ts`, `sessions.ts`, `takeaways.ts`, `tasks.ts`, `catalog.ts`
  y `public.ts` son el port de `functions/src/fase2`.

## Cómo funciona una operación

1. `execute.ts` valida permiso (`FASE2_ACCESS`), módulo y local del miembro (`sala_members`).
2. `context.ts` toma un bloqueo consultivo por local (exclusivo al escribir, compartido en las lecturas) y lee **solo lo vivo**: catálogo y plano,
   mesas abiertas (más las juntadas en ellas), sus líneas y pedidos, tareas activas, recogidas
   vigentes. Nunca el histórico; lo que una operación necesite de una mesa cerrada se pide por id.
3. El manejador trabaja en memoria con los esquemas de core; `flush()` escribe solo lo que cambió
   (`revision` + 1), emite un evento por entidad (`emitEvent`) y encola los avisos de recogida
   (`enqueueOutbox`, `aviso.recogida`, ID estable) en la misma transacción.
4. `enviarPedido` y `pedirDesdeMesa` con `requestId` guardan su recibo en `sala_submissions`:
   repetir devuelve el mismo resultado sin duplicar la comanda ni las raciones.

## Operaciones públicas

`sala_public_scope(slug, local)` (SECURITY DEFINER) resuelve el restaurante y abre un alcance de **restaurante y
local** (`app.sala_public`, `app.sala_public_location`) solo dentro de esa transacción; las políticas `sala_public`
lo exigen y no abren `sala_private` más que para los enlaces de mesa y el seguimiento de recogidas (nunca las
suscripciones push). La credencial de la mesa se comprueba **antes** de cargar el contexto. El seguimiento de una
recogida localiza el local con `sala_takeaway_locate`.

Antiabuso (`sala_rate_limit`, ventana fija fuera de la transacción para que los intentos fallidos cuenten), por **IP
verificada del servidor** (`client-ip.ts`, `context.clientIp`) y por **credencial** (hash del token o teléfono/correo),
nunca por restaurante: quien satura la suya no deja sin QR, recogida ni carta a los demás. Un slug que no existe solo
consume el cubo de su IP. Campo trampa `website`. `verCartaPublica` lee solo las tablas de carta, sin bloqueo, y se
sirve de memoria 15 s por local (los cambios de carta tardan hasta ese tiempo en verse en la web pública).

## Secretos

Los enlaces de mesa, el seguimiento de recogidas y las claves push se guardan **cifrados** (AES-256-GCM, ligado al
restaurante) con la clave `SALA_SECRET_KEY_FILE` (hexadecimal de 32 bytes, la misma custodia que el resto de claves del
servidor). En SQL solo quedan hashes legibles. Sin clave, regenerar o recuperar un QR y crear una recogida fallan con
`failed-precondition` (503). El worker de avisos debe abrir `tokenSecret` con la misma función (`secrets.ts`).
`loadContext` solo carga los enlaces de las mesas que la operación nombra.

## Contrato con otros agentes (puntos de acoplamiento)

- **Caja (V5), hecho:** `billing.ts` registra el origen del consumo (`registerBillSource`) con
  `core.billLinesFromOrderLines`; con el módulo `pos` activo sala no cierra una mesa ni marca recogida con importe sin
  la cuenta saldada, y con la cuenta en cobro o saldada no mueve, junta, separa, anula ni añade consumo (también desde
  la mesa pública; migración `009_sala_caja.sql` da lectura de `pos_bills` al alcance público). Falta: la cola de
  comandas de cocina (`solicitarImpresion kind kitchen`) y las estaciones de impresora, que caja deja en `not-deployed`.
- **Plano de mesas (V3):** plano unificado: sala lee directamente de `dining_tables` (columna `data` = `core.TableSchema`),
  compartiendo las mesas con reservas.
- **Reservas (V3), hecho (V11):**
  - *Ocupación.* Sala registra su fuente con `registerOccupancySource('sala', …)` (`occupancy.ts`): reservas la usa en cada
    disponibilidad, también pública, con la función SQL estrecha `reservas_open_sessions` (solo mesas, comensales, hora y
    reserva de origen, nunca nombres ni consumo), y no cuenta dos veces la reserva que ya representa una sesión. A la
    inversa, `loadContext` carga las reservas pendientes, confirmadas y sentadas de la ventana (−12 h, +36 h, máximo 500,
    índice por local y día) y `validateTables` las respeta: no se abre una mesa reservada.
  - *Sentar.* `abrirMesa` con `reservationId` (`sessions.ts`, `reservations.ts`) pasa la reserva a sentada **por la ruta de
    reservas** (`changeStatus`: transición, capacidad, ficha, origen, avisos y evento de plataforma) y abre la sesión con
    las mesas de la reserva, que deben coincidir. Repetirlo devuelve la misma sesión. Cerrar la mesa (también las juntadas
    en ella) termina las reservas sentadas con el mismo camino; hace falta `reservas.gestionar` y el módulo de reservas.
  - *Ganchos (`hooks-reservas.ts`).* Al sentar una reserva desde reservas se abre la sesión (si hay sala y el actor puede
    gestionarla; si no, la reserva ocupa sus mesas y la sesión se abre desde sala); al terminarla se cierra la mesa con
    los requisitos de servicio y caja; y antes de reasignar mesas se comprueba que la cuenta no esté en cobro.
  - *Bloqueos.* Un solo orden en toda la API: reservas, sala y caja. Solo las operaciones que validan mesas contra
    reservas (`abrirMesa`, `moverMesa`, `juntarMesas`, `separarMesas`, `cambiarEstadoMesa`, `editarMesa` con comensales;
    `LoadOptions.validatesTables`) toman el cerrojo de reservas y cargan las del local (−12 h, +36 h); cocina, barra,
    pedidos y tareas no. Si hubiera más de 500 reservas en esa ventana la operación falla con `failed-precondition`
    en vez de recortar en silencio, y una reserva mal formada se salta y se registra (`sala_reserva_mal_formada`).
    Caja toma reservas y sala en compartido antes de su cerrojo (`openPos`): sala no puede añadir consumo a una cuenta
    que caja está bloqueando, ni al revés (probado con `enviarPedido` contra `prepararCobro`).
- **Ajustes de reservas (V3):** horarios, duraciones y zona horaria salen de `reservation_settings` (la misma fuente que
  reservas, política de lectura para el alcance público de sala en la migración 014). `sala_settings` solo guarda `floor`;
  una fila `reservations` antigua se ignora.
- **Avisos de recogida (V2):** el worker consume `llenamos.outbox` con `kind='aviso.recogida'` y payload
  `{locationId, takeawayId, template, channel}`. Lee el contacto en `sala_takeaways.doc` y abre el seguimiento en
  `sala_private` (`takeawaySecrets`). Si el proveedor (WhatsApp) no está configurado, el trabajo falla con su código; la
  comprobación previa del original (no encolar WhatsApp sin plantilla) la hace el worker.
- **Eventos de plataforma (V7/API pública):** `order.placed` y `orderLine.statusChanged` salen al outbox
  (`kind='plataforma.evento'`, ID estable, sin datos personales). Quien entregue webhooks los consume de ahí.
- **Inventario (V6):** el consumo por línea (`consumeLine`, rama `vps/v6-personal-inventario`,
  `modules/inventario/consumo.ts`) no está en esta base. Debe llamarse al pasar una línea a `preparing` o `served`
  según la regla del original, dentro de `cambiarEstadoLineas`/`marcharPase` (`orders.ts`, `lineStatus` en `service.ts`),
  en la misma transacción. Pendiente de fusionar V6.
- **Sin conexión (hecho, W2):** `sync.ts` registra con `registerSyncExecutor`/`registerSyncEntities` las cinco operaciones de la cola
  (`enviarPedido`, `marcharPase`, `cambiarEstadoLineas`, `cambiarEstadoTarea`, `marcarAgotado`). Cada ejecutor llama a `runStaff`
  (permisos, módulo, contexto acotado, `requestId = commandId`) dentro de la transacción del servicio. La versión de una entidad es la
  huella de su `revision`, su contenido y el de sus líneas; la huella de contenido es la de la lectura en vivo.
- **Push de tareas vencidas (hecho, W2):** `push-envio.ts`. Cada minuto, `pushMaintenance` encola `sala.avisos_push` por local con
  tareas abiertas, vencidas y sin responsable y alguna suscripción activa (ID estable por local y minuto; sin claves VAPID no
  encola). El manejador envía un aviso por tarea, hora de vencimiento y suscripción: reserva la entrega en
  `sala_push_deliveries` (migración 019: lease, intentos máximo 3, espera de un minuto), comprueba otra vez tarea, miembro
  activo con `tareas.atender`, local y clave VAPID, y envía **fuera** de la transacción. 404 o 410 desactivan la suscripción
  (si no se renovó mientras tanto). `SALA_PUSH_CAPTURE=1` guarda el aviso sin enviarlo (solo pruebas). El worker lee los
  miembros de `memberships` con su política `worker_membership` (no por `sala_members`, que depende del actor).
- **Privacidad de `sala_spend` (hecho):** `salaPrivacy` exporta (`gasto_sala`) y borra el gasto por cliente; está en `personalData` y en `KNOWN_PERSONAL_TABLES`. Migración `017` da `DELETE` al worker.
- **Reservas al validar mesas:** `loadContext` carga solo las reservas que tocan las mesas de la operación (`table_ids && …`, opción `tableIds` más las mesas de las sesiones enfocadas); el volumen de la agenda no puede tumbar abrir, mover, juntar ni separar.
- **Marchar recogidas (`jobs.ts`, hecho):** `salaMaintenance` encola cada minuto (solo locales con platos retenidos cuya hora ya llegó) `sala.marchar_recogidas` por local con recogidas
  aceptadas y el worker marcha los platos cuya hora (`fireAt`) llegó (`marcharParaLlevar` del original).
- **Avisos de recogida (hecho):** `aviso.recogida` abre `takeawaySecrets`, lo contrasta con `manageTokenHash` y envía
  `/r/{slug}/para-llevar/{ref}?t=…`; cancela si el pedido ya no está aceptado/listo y deja rastro sin destinatario.
- **Fotos (V2/W2):** la web sube la foto como archivo `carta_foto` y guarda `restaurants/{rid}/locations/{lid}/menu/{plato}/{idArchivo}`; `guardarPlato` exige `photoPath` bajo `restaurants/{rid}/locations/{lid}/menu/{itemId}/`.

## Lo que el original hacía y aquí no (documentado a propósito)

- **Ficha de cliente y gasto (hecho en V11):** al abrir mesa o pedir para llevar se da de alta la ficha en `customers`
  (solo alta, no pisa la de reservas; un teléfono no válido no crea ficha ni impide servir) y, al guardar, `reconcileSpend`
  (`clientes.ts`) suma el consumo de las mesas cerradas y recogidas entregadas a `customers.data.spentCents`, con el aporte
  de cada destino en `sala_spend` (cantidad absoluta: repetir no suma, reabrir resta, cambiar de cliente traslada). Sin ficha
  (borrada por privacidad) no se anota nada y el servicio sigue. **Privacidad (V9):** `sala_spend` lleva el id del cliente
  y debe entrar en la exportación y el borrado: la privacidad de sala es de V9 (se fusiona antes) y no se tocó aquí;
  al fusionar hay que unir `sala_spend` a su inventario.
  El gasto es el **total de la mesa o recogida** (suma de líneas), sin descuentos ni devoluciones de caja, como el original.
  Si falta la ficha o el gasto quedaría negativo, no se aplica nada, se registra `sala_gasto_no_aplicado` y el servicio sigue.
- **Registro de actividad** por restaurante con actor y resumen: solo eventos de dominio sin datos personales; la
  auditoría es de plataforma.
- **`notifications` en `verParaLlevarPublico`:** el estado de los avisos vive en el outbox y la API pública no lo expone
  todavía; el campo (opcional) se omite.
- Lecturas: `salaServicio` (vivo, con aviso `truncated`), `salaHistorial` (cerrado en las últimas 18 h, hasta 200 mesas y
  200 recogidas con sus líneas), `salaCarta` y `cocinaLineas`; todas comprueban miembro activo, local, módulo y rol como
  las reglas de Firestore (servicio e historial solo propietario, encargado y camarero; estaciones según `stationReader`;
  cocina y barra solo su estación). Más antiguo que eso: no hay consulta paginada todavía.

## Pruebas

`sala.integration.test.ts` (PostgreSQL real, `TEST_POSTGRES_API=1`, vía `apiServer` y HTTP):
carta con versión de precio, recorrido completo, concurrencia, idempotencia, QR (token falso y rotado),
aprobación de pedidos, avisos de mesa, recogida con seguimiento y avisos, antiabuso, aislamiento entre
restaurantes, roles y locales, lecturas en vivo y la carta pública. `web-push.test.ts` cubre RFC 8291/8292.
