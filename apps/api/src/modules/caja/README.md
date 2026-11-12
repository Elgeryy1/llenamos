# Módulo caja (V5)

Cuentas, cobros, devoluciones, cierre y propinas, fiscal (VERI*FACTU de prueba) y cola de impresión.
Migración `009_caja.sql`. Contratos de `@llenamos/core` (`CALLABLES_FASE3`) sin cambios.

## Operaciones registradas

Las 17 de caja y fiscal, más `guardarImpresora`, `vincularPuente`, `solicitarImpresion` (miembro con rol y
permiso de `FASE3_ACCESS`) y `reclamarImpresiones`, `confirmarImpresion` (puente, públicas con credencial propia).
Todas validan miembro activo, local permitido y módulo `pos` (y `floor` donde toca) dentro de la transacción.

- **Serialización**: cada operación toma un cerrojo consultivo por local (`pos:<restaurante>:<local>`). Sustituye a
  `reservationLocks/current`: saldo, cierre, correlativo y cadena fiscal se leen y escriben sin carreras. La cadena
  fiscal añade su propio cerrojo (`fiscal:<cadena>`) porque abarca locales.
- **Idempotencia**: `llenamos.idempotency` por actor, operación y `local:requestId`. Misma carga devuelve el resultado
  guardado; otra carga con la misma clave da `already-exists`. `vincularPuente` no se guarda (rota el secreto).
- **Sin doble cobro**: idempotencia + cuenta bloqueada con revisión esperada + saldo de la parte bajo cerrojo + índice
  único del apunte de datáfono. **Sin doble sello**: la parte lleva una sola factura (`pos_invoices_part_once`),
  correlativo único por serie y número único por emisor. **Sin doble impresión**: el ID de trabajo es un hash de
  tipo, origen, impresora y copia; una copia es una acción explícita con contador.
- **Eventos** (sin datos personales): `caja.cuenta`, `caja.cobro`, `caja.devolucion`, `caja.turno`, `caja.factura`,
  `caja.impresion`.
- **Lecturas en vivo** (`liveQueries`): `cajaCuentas`/`cajaCuenta` (`caja.ver`, módulos `pos` y `floor`), `cajaHistorial` y `cajaImpresion` (estados, `caja.ver`),
  `cajaTurnos`/`cajaTurno` (`caja.gestionar`), `cajaImpresoras` (`impresion.gestionar`) y `cajaRevisiones` (`caja.rectificar`). Todas acotadas por límite o por clave; nada de históricos completos.

## Lo que necesita de otros módulos

- **Consumo de mesa y recogida (V4)**: caja no lee pedidos. V4 debe llamar a `registerBillSource(...)`
  (`modules/caja/source.ts`) con `load(client, scope, target)` que devuelva `{ customerId, lines, cancelled }` usando
  `core.billLinesFromOrderLines`. Mientras no exista, `abrirCuenta`, `verCuenta` con cuenta abierta y
  `anularRegistroFiscal` fallan con `not-deployed`.
- **Comandas de cocina (V4)**: `solicitarImpresion` con `kind: "kitchen"` falla con `not-deployed`; las estaciones de
  una impresora no se admiten hasta que cocina las publique (`guardarImpresora` con `stationIds` falla).
- **Señal de reserva (hecho en V11)**: `registrarCobro` con `method: "deposit"` descuenta la señal pagada (verificada por el
  receptor de webhooks) de la cuenta de la sesión de su reserva: sin propina, solo la sesión con reserva, nunca más de lo
  cobrado (varios cobros parciales con el mismo id de pago, por eso la migración 014 saca `deposit` del índice de referencia
  única), sin devolución previa. El cobro y el cerrojo del local y la fila de la reserva serializan los cobros simultáneos.
  Cada cobro correcto deja `payment.succeeded` de plataforma (`enqueuePlatformEvent`, id por cobro) y, al saldar o devolver,
  las ventas netas de la reserva en su origen.
  Los cobros toman reservas y sala en compartido antes de su cerrojo (orden único reservas, sala, caja). La suma de lo
  aplicado usa el índice parcial `pos_payments_deposit`. **Limitación conocida:** las devoluciones de una señal se guardan
  `failed` y sin `externalId` (no hay reembolso real), así que la comprobación «ya tiene una devolución» de
  `applyDeposit` no salta hasta que exista el reembolso con Stripe; mientras, `devolverCobro` de la señal queda `not_configured`.
  Cerrar, mover, juntar o anular una mesa con la cuenta sin saldar o en cobro lo impide el guarda de sala (`guardBills` en `sala/context.ts`), probado de punta a punta.
- **Qué guarda el receptor de `webhook.stripe`** (`webhooks/receiver.ts`, `stripeObject`): `eventId`, `type`, `created`, `livemode`, `account` y, del objeto, solo `id`, `payment_status`, `amount_total`, `currency` y los metadatos propios (`kind`, `reservationId`, `locationId`, `restaurantId`, `checkoutId`, `amountCents`, `tipCents`). Nunca `customer_details`, correo, nombre ni dirección del pagador.
- **`webhook.stripe` de caja:** un evento con `metadata.checkoutId` (cobro móvil) va a cuarentena `cobro-movil-no-portado`; no se ignora ni se registra.
- **Reembolsos con Stripe:** un reembolso de un cobro `stripe` o `deposit` queda `not_configured`, nunca simulado (no se guarda el
  `payment_intent`; se devuelve desde el panel de Stripe del restaurante y se anota aparte). Pendiente.

## Cobro móvil, recibo digital y Stripe del restaurante (W3, migración 020)

Todo con la clave de Stripe **del propio restaurante**, guardada en su bóveda cifrada (`integration_secrets`). La API abre esa
clave solo en la petición pública en curso: `payments_stripe_ciphertext(rid)` devuelve el texto sellado únicamente si
`app.public_restaurant` es ese restaurante (nunca el de otro, nunca sin ámbito), y de él solo se usa Stripe
(`payments/credentials.ts`). El rol de la API no lee la tabla. `configureStripeVault` lo conecta `main.ts` al arrancar. Sin
clave o sin custodia, las operaciones dicen `not_configured` o fallan con su código; no hay clave global ni de reserva.

- **Operaciones:** `crearEnlaceCobro` y `crearReciboDigital` (personal, `caja.cobrar`; idempotentes por `requestId`),
  `verCobroPublico`, `iniciarPagoCuenta`, `verPartesPagoMesa`, `elegirPartePagoMesa` y `verReciboDigital` (públicas con el
  secreto del enlace). Esquemas de las respuestas VPS en `@llenamos/core` (`api-caja-movil.ts`).
- **Antiabuso de los enlaces:** límite en memoria, por IP y restaurante, bloqueo por fallos por IP y por referencia (también
  para el secreto correcto) antes de abrir ninguna credencial; el secreto se compara en tiempo constante contra su hash.
- **Pago:** `iniciarPagoCuenta` valida enlace, saldo, caja abierta y consentimiento, reserva la parte (índice único del intento
  vivo `pos_mobile_part_inflight`), abre la clave y crea la sesión con una clave de idempotencia estable; un corte deja el
  intento reservado y lo recupera el worker con la misma clave. La respuesta de Stripe se valida (importe, moneda, metadatos,
  modo y dominio `checkout.stripe.com`).
- **Reserva de saldo:** mientras un intento sigue vivo, el cobro en caja de esa parte no puede pasar del saldo libre, la cuenta
  no se salda y no se puede dividir ni desbloquear.
- **Confirmación:** `webhook.stripe` (receptor firmado con el secreto de ese restaurante) → `stripeCashHandler`. El cobro de caja
  (`method='stripe'`, referencia externa = ID de sesión, índice único) se asienta en la única caja abierta con el mismo código que
  el cobro en caja. Importe, moneda, sesión, cuenta conectada o modo que no cuadran, caja cerrada o pago fuera de plazo no cobran:
  quedan como incidencia (`pos_mobile_incidents`, lectura `cajaIncidencias`) y el cobro pasa a `reconciliation_required`.
- **Factura y recibo:** tras el cobro, `finishInvoice` emite la factura de la parte (simplificada, o completa con destinatario)
  y crea el recibo digital; con consentimiento y correo se encola el aviso `digital_receipt` con ID estable. Sin proveedor
  fiscal el cobro queda confirmado y la factura `not_configured` (la emite el personal a mano); no se inventa documento.
- **Conciliación:** el worker (`cajaMaintenance`, cada 5 minutos) encola `caja.reconciliar_cobro` por cobro pendiente: recupera
  creaciones inciertas (misma clave, dentro de las 23 h de idempotencia de Stripe), consulta la sesión, termina facturas y copia
  al recibo el resultado del correo.
- **Qué configura el restaurante en Stripe:** su clave secreta y el secreto del webhook (`stripe.secretKey`, `stripe.webhookSecret`,
  opcional `mobileWebhookSecret` y `accountId` si cobra con cuenta conectada) en su configuración de proveedores; un endpoint de
  webhook hacia `/v1/webhooks/stripe/<id del restaurante>` con los eventos `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` y `checkout.session.expired`. La API y el
  worker necesitan `PUBLIC_APP_URL` (HTTPS) para los enlaces de vuelta y del recibo.
- **Revisión del coordinador:** `cerrarCaja` falla mientras haya un cobro móvil vivo en esa caja. Un rechazo definitivo de Stripe
  (4xx salvo 408, 409 y 429) pasa el intento a `failed` y libera la parte; sin credenciales del restaurante, pasada una hora queda como
  incidencia `sin_credenciales`; `async_payment_failed` libera la parte. El personal dispone de `cancelarCobroMovil` (caduca también la
  sesión en Stripe por el trabajo `caja.expirar_sesion`) y `resolverIncidenciaMovil`. Los secretos de enlace no se guardan en claro:
  `crearEnlaceCobro` y `crearReciboDigital` salen de la tabla de idempotencia y repetir la solicitud rota el secreto del mismo cobro o
  recibo; la ruta del recibo del cobro móvil se guarda sellada con la custodia de sala. El plazo de pago tardío solo se aplica a la hora
  del evento firmado, no a una consulta posterior. **Pendiente, documentado:** las políticas públicas de lectura (020) siguen siendo
  por restaurante, no por cobro; y `success_url` de la señal lleva el enlace de gestión de la reserva (la página de vuelta es de W1).
- **Lecturas en vivo nuevas:** `cajaIncidencias` y `cajaEquipo` (solo id y nombre) (equipo activo del local para repartir propinas).

## Fiscal

No hay adaptador fiscal real. Sin `LLENAMOS_FISCAL_TEST_MODE=1`, `guardarConfiguracionCaja` y toda emisión fallan
con `not-configured` y no consumen correlativo. Con el modo de prueba el registro se encadena (hash VERI*FACTU),
queda `queued` en `pos_fiscal_outbox` y se avisa con `outbox` (`caja.fiscal_registro`, ID estable); todo sale marcado
«no válido para Hacienda». **El envío (worker con adaptador) y la subsanación de rechazos no están portados.**
La cadena se verifica por la cola (cabeza, último registro reconstruido y enlace con el anterior) en cada emisión;
`verifyFullChain` la verifica entera desde el génesis, por páginas, para revisión.

## Impresión y puente

La credencial del puente se guarda como SHA-256 y solo se muestra al rotarla. El puente no tiene usuario: usa dos
funciones `SECURITY DEFINER` (`pos_bridge_claim`, `pos_bridge_confirm`) que comprueban la credencial; reclaman con
`FOR UPDATE SKIP LOCKED`, lease de 60 s y token de lease propio por trabajo. Un lease caducado pasa a `uncertain`
(puede haber salido papel) y nunca se reencola solo. Solicitudes sin impresora quedan `not_configured` y se reprocesan
al guardar una impresora (equivale al disparador `impresoraActualizada`).

## Pendientes conocidos de la revisión (no resueltos, a propósito)
- `vincularPuente` no es idempotente: un reintento rota la credencial otra vez (guardarla en claro para recuperarla 10 min era peor).
- No hay actividad por operación con actor y motivo ni incidencias de integridad fiscal: el registro de auditoría es de plataforma (V1/tanda 2); aquí solo hay eventos de dominio sin datos personales.
- Web: las lecturas VPS siempre marcan `fresh: true` (el contrato de `useLiveQuery` no informa de obsolescencia) y `datos.ts` aún importa las restricciones de `firebase/firestore` (limpieza de tanda 2).
