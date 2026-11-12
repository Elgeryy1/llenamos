# Plataforma restante en PostgreSQL (V8)

Porta `functions/src/fase6-billing` (alta, prueba, suscripción, catálogo, excepciones, webhook de Billing) y
`functions/src/fase6-api` (claves de API, webhooks salientes, uso de plataforma). Migración `012_billing_api.sql`.
Reutiliza de `src/platform`: catálogo y cuotas (`platform_plans`, `platform_subscriptions`, `platform_usage`),
recibos de plataforma (`platform_request`, ampliado con los comandos nuevos), `readPlan`/`subscriptionFromRow` y la
custodia `PLATFORM_INTEGRATION_KEY_FILE`. `listarPlanesDisponibles`, el alta administrativa y la configuración
siguen siendo las de `src/platform`; aquí no se duplican.

## Operaciones (nombres y contratos de `@llenamos/core`)

| Operación | Quién | Notas |
| --- | --- | --- |
| `guardarAlta`, `completarAlta` | cuenta con identidad vigente | Apagadas salvo que estén encendidos **los dos** interruptores: `PLATFORM_SELF_SIGNUP=1` (API) y `platform_flags('self_signup')` (base). Máximo 5 borradores abiertos. Una prueba por buzón. |
| `verSuscripcion` | owner, manager | Aplica en SQL el vencimiento (prueba, gracia, periodo) la primera vez que se mira. |
| `iniciarSuscripcion`, `abrirPortalFacturacion`, `cancelarSuscripcion` | owner | Sin Stripe configurado responden `not_configured`: no se cobra ni se simula. |
| `verUsoPlataforma` | owner, manager | Recuento real por SQL en el momento; sin caché. |
| `guardarPlanPlataforma`, `cambiarExcepcionesPlataforma`, `listarRestaurantesLogiqd`, `abrirAccesoSoporte` | plataforma | Versiones de plan inmutables y con precio de Stripe único; excepciones con revisión y motivo; listado solo con contadores. |
| `listarIntegraciones`, `crearClaveApi`, `revocarClaveApi`, `guardarWebhook`, `rotarSecretoWebhook`, `repetirEntregaWebhook` | owner, manager | Con suscripción vigente. Un manager acotado a locales solo toca los suyos. |

Acceso nuevo `account` en `src/operations.ts`/`server.ts`: identidad vigente y no operadora; con `restaurantId` exige
rol pero **no** que la suscripción esté al día. Es la única forma de que un restaurante suspendido pueda ver su plan y
pagar sin abrir el resto de sus datos (RLS sigue cerrando todo lo demás).

## Seguridad y privilegios

- Las funciones `billing_*`, `api_key_authenticate` y `platform_emit_event` pertenecen a `llenamos_migrator`
  (`SECURITY DEFINER`, `search_path` fijo). Quién puede ejecutarlas:
  - **`llenamos_webhook`** (el login del receptor de V2, que no es miembro de `llenamos_app`): solo `billing_event_*`
    (aplicar eventos de Stripe Billing). Ni la API ni el worker las ejecutan.
  - **`llenamos_worker`**: solo el mantenimiento, `billing_expire_due` y `billing_deliveries_sweep`.
  - **`llenamos_app`** (API): el resto, y todas comprueban al actor en SQL (`billing_member`, `billing_operator`,
    identidad no bloqueada, contexto de restaurante). `billing_onboarding_complete` mira además `platform_flags`.
  Una inyección SQL en la API no puede aplicar un `invoice.paid`, activar un plan ni abrir pruebas.
- `api_keys`, `webhook_endpoints`, `webhook_deliveries` y `webhook_attempts`: solo owner/manager del restaurante con
  servicio vigente (o el worker de ese restaurante). El hash de la clave **no se puede leer** con SQL de la API
  (privilegio por columnas); `api_key_authenticate` lo compara. `webhook_secrets` solo lo lee el worker para firmar.
- `platform_emit_event` es `SECURITY DEFINER` y solo actúa sobre el restaurante del contexto de la transacción
  (`app.restaurant_id`, ámbito público `app.public_restaurant` o el de Billing): sirve a los flujos públicos y al worker,
  y no fabrica eventos de otro restaurante (42501).
- Las claves de API se guardan **solo como SHA-256**. El token se devuelve una vez; el recibo idempotente guarda la
  respuesta cifrada (AES-256-GCM, contexto ligado a restaurante/actor/operación) y caduca a las 24 h. Los secretos de
  webhook se guardan cifrados (necesarios para firmar) con el contexto `webhook:<rid>:<endpoint>:<versión>`.
- Destinos de webhook: HTTPS público, sin puerto, credenciales ni redirecciones; DNS verificado (con tiempo límite de 3 s)
  al guardar y en cada envío, con la dirección fijada al socket (anti SSRF). `3fff::/20` y los rangos privados se rechazan.
- Una prueba gratis por **buzón** normalizado (sin `+alias` ni puntos de Gmail): otro `uid` con el mismo buzón no abre otra.
  Una suscripción de Stripe solo se vincula a un restaurante (índice único).
- Facturas: se comprueban importe, moneda, precio (versión única del catálogo), periodo y estado; con prorrateo se acepta
  la factura si las líneas suman el total y la de tarifa no supera su precio; un evento antiguo obliga a consultar a Stripe;
  un contrato dado de baja no se reactiva; la vuelta de Checkout no activa nada; un evento de otro modo (`livemode`) se rechaza.

## Stripe Billing (webhook)

`billingWebhookRoute({pool})` atiende `POST /v1/webhooks/stripe-billing` con el secreto **de la plataforma**
(`STRIPE_BILLING_WEBHOOK_SECRET_FILE`); sin él, o con el fichero ausente, responde 503 (Billing sin configurar) y el
arranque no se cae. `pool` es el login `llenamos_webhook`: `main.ts` lo monta junto al receptor de V2 cuando existe
`WEBHOOK_DATABASE_URL_FILE`. No va por el receptor por restaurante de V2: allí firma cada restaurante con su propio
secreto, que no es de fiar para conceder o quitar servicio (un restaurante podría fabricarse un `invoice.paid`).
`handleBillingEvent(runner, evento)` es idempotente por ID de evento (`billing_events`); códigos: 5xx = Stripe debe
reintentar (contrato sin vincular, evento desordenado sin Stripe, carrera); 4xx = no se aplica.

Ciclo de un contrato de pago:
- **Renovación**: Stripe adelanta el periodo (`customer.subscription.updated`, que con el contrato `active` mueve
  `period_ends_at` hasta un tope de 400 días) y cobra la factura después. Si el periodo vence antes de que llegue la factura,
  el barrido pasa un contrato activo, vinculado a Stripe y sin baja programada a `past_due` con **48 h de margen**
  (módulos intactos, `renewal_grace`); `invoice.paid` lo devuelve a `active`. Sin Stripe o con baja programada, al vencer
  se suspende o se da de baja.
- **Impago**: `invoice.payment_failed` abre **siete días** de gracia; si venía del margen de renovación, se sustituyen
  (el margen no los consume); un segundo fallo no los alarga. Pasada la gracia, el barrido suspende.
- **Checkout abandonado**: `checkout.session.expired` libera la intención pendiente; sin aviso, caduca a las 24 h.
- **Factura que no cabe** (`blocked_overage`): el contrato queda suspendido y el evento **se reaplica** al reenviarlo desde
  Stripe cuando el uso ya cabe en el plan.

La creación de Checkout/portal y la baja programada se hacen dentro de la petición (la persona necesita el enlace),
con la transacción abierta pero sin ningún bloqueo de fila y con la intención como clave de idempotencia de Stripe;
no cobran. El escrito final revalida revisión e intención bajo bloqueo. Excepción documentada a «sin llamadas externas en
la petición». El Checkout no admite prorrateo; en un cambio de plan por el portal el prorrateo lo decide la configuración
del portal de Stripe (la API no lo expone en `subscription_update_confirm`) y la factura resultante se acepta (ver arriba).

Variables: `STRIPE_BILLING_SECRET_KEY_FILE` (su prefijo `sk_live_`/`sk_test_` fija el modo admitido),
`STRIPE_BILLING_RETURN_ORIGIN` (HTTPS), `STRIPE_BILLING_WEBHOOK_SECRET_FILE`, `PLATFORM_SELF_SIGNUP=1`,
`ONBOARDING_TERMS_VERSION` (por defecto `alta-provisional-v1`). Para abrir el alta propia en la base, quien administra
ejecuta con el rol bootstrap: `INSERT INTO llenamos.platform_flags(name,enabled) VALUES('self_signup',true) ON CONFLICT(name) DO UPDATE SET enabled=true`.

## API pública y webhooks salientes

- `publicApiRoute()` (montada en `main.ts`) sirve `GET /v1/restaurants/:rid/locations/:lid/{menu,orders}` con
  `Authorization: Bearer <clave>`. **Antes de autenticar** frena por IP verificada (`src/client-ip.ts`, 300/min); el límite
  por clave (60/min) y por restaurante (300/min) solo cuenta peticiones con clave válida y vive en `api_key_authenticate`
  junto a hash, caducidad, revocación, alcance, local, módulo `floor` y suscripción. El mapa de IP no se reinicia al llenarse:
  retira las ventanas vencidas y, si hace falta, la más antigua.
- Los datos los aportan sus dueños con `registerApiReaders({menu, orders})` (V4: carta y pedidos). **Sin lector
  registrado responde 501**, no inventa datos. La petición no tiene sesión: un lector debe llamar a una función SQL
  `SECURITY DEFINER` estrecha (restaurante + local) y puede paginar con `signCursor`/`verifyCursor` (`custody.ts`).
- Productores de eventos: `enqueuePlatformEvent(client, {id, type, restaurantId, locationId, data})` dentro de la
  transacción del hecho, con `platformEventId(...)` determinista. Crea una entrega por webhook activo suscrito y su
  trabajo `plataforma.entrega` en `outbox`. Los hechos que otro módulo deja en la cola como `plataforma.evento`
  (sala ya lo hace: `order.placed`, `orderLine.statusChanged`) los convierte el manejador del mismo nombre. Billing emite
  `subscription.changed`. Reservas (`reservation.created`/`statusChanged`) y caja (`payment.succeeded`) ya llaman a `enqueuePlatformEvent` (V11). **Pendiente de conectar**: privacidad
  (`privacy.completed`) deben llamar a `enqueuePlatformEvent` o dejar un `plataforma.evento`.
- Worker (todo registrado ya): `plataformaWorkerHandlers()` está en `workerHandlers` del módulo. `plataforma.entrega`
  reclama con lease propio, renueva el lease de la cola antes de salir a la red, envía **fuera** de la transacción,
  registra el intento y, si falla, encola un trabajo nuevo con espera creciente (12 intentos y luego `exhausted` con el destino
  suspendido; 410 revoca). Con el lease de otro intento vigente lanza `RetryLater` (la cola reintenta, no se da por hecho).
  `platformMaintenance(pool)` (en `worker-main.ts`) corre dos tareas: `suscripciones-vencidas` (cada 10 min) y
  `entregas-webhook` (cada 5 min), que vuelve a encolar entregas con lease vencido o trabajo perdido o en cuarentena.
- Un 4xx del receptor distinto de 410 y 429 **agota la entrega a la primera** (no se reintenta lo que el receptor rechaza):
  `repetirEntregaWebhook` la reabre cuando el receptor se haya arreglado.

## Alta propia: qué crea

`completarAlta` crea restaurante, local `principal`, propietario, suscripción de prueba y uso (función SQL) y, como el propio
propietario, los ajustes mínimos: `reservation_settings`, `sala_settings` (`floor` y `reservations`), estación `cocina`,
zona y mesas (`dining_*`, seis de cuatro plazas si no se pidió plano) y, si se pidió, una carta interna con
alérgenos sin revisar y sin pedido público. Revisión y publicación de la carta quedan para el panel.

## Límites conocidos

- Alta por cuenta propia: el correo y el nombre del propietario salen de una membresía que la cuenta ya tiene
  (acreditada por una invitación aceptada). Falta el alta de **identidades nuevas** con correo verificado desde un ID
  token de Firebase (el token no lleva `email_verified`); sin ello un usuario recién registrado no llega a la API.
  Por eso los interruptores van apagados por defecto. No se limita por cliente de Stripe (un cliente puede tener varios contratos).
- `pendingCommands` de `verUsoPlataforma` vale 0 hasta que se lea la tabla de sincronización de V1.
- `abrirAccesoSoporte` deja constancia con caducidad (`platform_support_access`, auditoría); no concede lectura del
  interior, en línea con la separación acordada.
- Sin cambio de plan por el portal de Stripe fuera del catálogo: un `customer.subscription.updated` con otro precio se rechaza
  hasta tener la factura y la comprobación de cuotas (igual que el origen).
- No hay web nueva: `lib/data/callables` (V1) lleva estas operaciones; los contratos no cambian.
- Todo contra Stripe real queda sin probar: solo hay pruebas con transporte y eventos firmados inyectados. El tiempo límite
  del DNS (3 s) no tiene prueba automática (necesitaría un DNS colgado).
