# Proveedores del restaurante y lecturas de avisos y equipo (W1)

Migración `018_w1_proveedores_restaurante.sql`.

## Claves de proveedores (Stripe, WhatsApp, correo, fiscal, Repite)

Las pone el propio restaurante y quedan en su bóveda cifrada (`integration_secrets`, más los secretos de firma de
webhooks en `integration_webhook_secrets`). Hasta ahora solo las escribía el operador de plataforma
(`altaRestauranteLogiqd` / `configurarRestauranteLogiqd`); esas dos operaciones siguen existiendo y comparten bóveda.

| Operación | Quién | Qué hace |
| --- | --- | --- |
| `verProveedoresRestaurante` | propietario (`propietarios.gestionar`) | Estado por proveedor y **nombres** de los campos guardados. Nunca valores. |
| `guardarProveedoresRestaurante` | propietario | `integrations` (un campo vacío conserva el valor) y `remove` (quita el proveedor entero). Devuelve lo mismo que `ver`. |

- El cifrado lo hace la API con `PLATFORM_INTEGRATION_KEY_FILE` (la bóveda de `platform/integrations.ts`); sin clave de
  custodia responde 503 `failed-precondition` y no guarda nada.
- SQL: `restaurant_vault_open(rid, escribir)` y `restaurant_vault_save(...)` (SECURITY DEFINER, dueño `llenamos_migrator`).
  Ambas llaman a `billing_member(rid, true)`: solo un propietario activo del restaurante, no bloqueado ni operador.
  Las políticas `owner_vault` solo abren la fila del restaurante que la propia función fija en `app.owner_vault`, dentro
  de su transacción. El rol HTTP no puede leer `integration_secrets` ni llamar a nada fuera de estas funciones.
- El estado derivado (`credentialsStatus`) se guarda también en `platform_restaurants.integration_status`, que es lo que
  lee la parte pública (`reservas_public_resolve`) para saber si hay Stripe.
- `OperationContext.integrationVault` (en `platform/service.ts` y `server.ts`) es el único cambio del contrato común: así
  los módulos acceden a la misma bóveda que la plataforma sin tocar `operations.ts`.
- Formato: lo que se escribe se valida en `GuardarProveedoresRestauranteInputSchema` (Stripe `sk_`/`rk_`, `whsec_`, `acct_`; remitente de correo). Lo ya guardado
  por plataforma no se revalida. `clear` vacía los campos opcionales (`CAMPOS_VACIABLES`: `accountId`, `mobileWebhookSecret`, plantillas de WhatsApp).
- Seguridad de las políticas `owner_vault`: además de la variable `app.owner_vault`, exigen que el actor sea propietario (`vault_owner_ok`), así que fijar la
  variable a mano no abre la bóveda a nadie más. `restaurant_vault_save` falla si el restaurante no tiene ficha en `platform_restaurants`.
- Señal de reserva: `reservas_public_resolve` (reemplazada en 018) solo da `stripe=true` con estado `configured`. Guardar la clave de Stripe (`adapter_pending`) no
  activa la señal: la reserva pública sigue como `not_configured` hasta que W3 tenga el conector y `credentialsStatus` marque Stripe como `configured`.
- Pendiente fuera de W1: Stripe, fiscal y Repite quedan `adapter_pending` hasta que su conector real use la clave
  (W3 para Stripe). WhatsApp y correo ya tienen consumidor en el worker.

## Lecturas en vivo

| Lectura | Roles | Contenido |
| --- | --- | --- |
| `mensajesRecientes` | `mensajes.ver` | Resultados (`message_deliveries`) más avisos aún en cola (`outbox`, tipo `mensaje.enviar`) de un restaurante, con `limit` hasta 200. |
| `mensajesReserva` | `mensajes.ver` | Lo mismo filtrado por reserva (índice `message_deliveries_reservation`). |
| `miembros` | cualquier miembro activo | Equipo del restaurante (`restaurant_members`, SECURITY DEFINER porque `memberships` solo deja ver la fila propia). |

- Cada fila se valida por separado con `MessageRowSchema` (el destinatario puede ser `suprimido` o vacío tras una petición de privacidad) y la que no encaje
  se descarta: una fila rara no tumba la bandeja. Los avisos enviados recuperan los datos de la cola (nombre del cliente) durante los 30 días que se conserva.
- Se ordena por creación del aviso, no por la hora de envío. Índices `outbox_notices_recent` y `outbox_notices_reservation` (probados con `EXPLAIN`).
- Los avisos no devuelven nunca `manageUrl`, `offerUrl`, `paymentUrl` ni `trackUrl` (llevan token mientras están en cola).
- La base guarda el asunto de cada aviso pero no su cuerpo: `rendered` es `null`. No se inventa texto.
- No existe un registro general de actividad en SQL (cada módulo tiene el suyo): la web enseña «no disponible» en VPS.
- Se refrescan por eventos de reservas y cada 10 s (los resultados del worker no emiten eventos).
