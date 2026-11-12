> **Integrado** (rama `fase6/integracion`): exportaciones, índices, retirada de la lectura por claim `logiqd` en `restaurants/{rid}` y productores de eventos (reservas, sala, caja y Billing) ya conectados. Ver «Integración de la fase 6» en ARQUITECTURA.md.

# Integración de la fila 3: Panel LogiQD, API y webhooks

Implementación en `fase6/panel-api`, puertos del agente 2. Sin dependencias nuevas, sin Stripe ni otros proveedores reales.

## Registro que debe aplicar el coordinador

En `functions/src/index.ts`:

```ts
export { listarRestaurantesLogiqd, verUsoPlataforma, abrirAccesoSoporte,
  listarIntegraciones, crearClaveApi, revocarClaveApi, guardarWebhook,
  rotarSecretoWebhook, repetirEntregaWebhook, plataformaApi } from './fase6-api'
```

Los servicios `enqueuePlatformEvent(tx, event)` y `assertIntegrationDestination(url)` se importan desde `./fase6-api` al conectar productores. No exportar los trabajadores como callables sin autorización. La entrada `emulador-entry.ts` (que también reexporta `cambiarExcepcionesPlataforma` de Billing para probar el editor de módulos) permite probar esta fila antes de integrar el índice común; `pnpm --filter functions exec tsup --config src/fase6-api/emulador.config.ts`. El build normal sigue compilando el índice común sin esta fila hasta que el coordinador lo integre.

Navegación como datos, sin editar `lib/panel/nav.ts`:

```json
[
  { "href": "/panel/integraciones", "label": "Integraciones", "permission": "integraciones.gestionar", "group": "administración", "modules": [] },
  { "href": "/logiqd", "label": "Equipo LogiQD", "claim": { "logiqd": true } }
]
```

## Reglas que debe integrar el coordinador

Todo se consulta por callable con permisos actuales. Mantener `allow read, write: if false` para `platformRequests`, `platformSupport`, `platformRestaurantUsage`, y bajo restaurante `apiKeys`, `webhookEndpoints`, `webhookSecrets`, `platformEvents`, `webhookDeliveries`, `webhookAttempts` y `platform`. Las reglas actuales ya deniegan estas rutas por defecto. No abrirlas al claim `logiqd`. Eliminar la excepción antigua de lectura general `request.auth.token.logiqd == true` de `restaurants/{rid}` cuando se integre el panel nuevo; el listado actual ya no la necesita.

Conservar lista cerrada de campos editables en el documento de restaurante: ningún cliente modifica plan, módulos, `commercialPlanId`, `commercialPlanVersion`, `entitlementVersion` ni `accessValidUntil`. La comprobación operativa de `accessValidUntil` en reglas comunes corresponde al coordinador/Billing. Estas pruebas verifican denegación de rutas y proyección, sin ampliar reglas.

Índices como datos para `firebase/firestore.indexes.json`:

```json
[
  { "collectionGroup": "webhookDeliveries", "queryScope": "COLLECTION", "fields": [
    { "fieldPath": "status", "order": "ASCENDING" },
    { "fieldPath": "nextAttemptAt", "order": "ASCENDING" }
  ] },
  { "collectionGroup": "platformRestaurantUsage", "queryScope": "COLLECTION", "fields": [
    { "fieldPath": "status", "order": "ASCENDING" },
    { "fieldPath": "__name__", "order": "ASCENDING" }
  ] }
]
```

No hay índices de grupo global para claves: búsqueda por hash dentro del restaurante, indexación simple predeterminada. Pedidos: orden `(placedAt,__name__)` mediante índice simple más desempate implícito. Los cursores incluyen actor/clave, restaurante, local, recurso/filtro y tamaño de página, tienen HMAC y vencen en una hora.

## Custodia, cuotas y trabajadores

`PLATFORM_API_MASTER_KEY`: 32 bytes en hexadecimal minúsculo, obligatorio en servidor fuera de `demo-llenamos` con Firestore emulado. Debe suministrarlo la custodia de secretos del despliegue. Deriva claves distintas para AES GCM y HMAC. `keyVersion: 1` identifica la primera configuración; antes de rotar esta clave maestra hace falta una migración de cifrado. No cambiarla sin conservar acceso a secretos y respuestas existentes. La alternativa determinista está restringida al emulador de demo; no es una clave de producción.

Cada mutación nueva valida permisos antes de recuperar respuesta, deduplica por actor, restaurante, operación y requestId, comprueba huella y guarda respuesta cifrada durante 24 horas. El vencimiento impide recuperar el secreto; no elimina la barrera de duplicados. No purgar `platformRequests` sin diseñar esa barrera. Listados nunca incluyen hash de token, cuerpo, lease ni ciphertext. El identificador de la clave es aleatorio y distinto del hash. Los secretos no pasan por localStorage, logs ni capturas.

Crear clave o webhook lee `platform/entitlements.limits`, cuenta documentos vivos y actualiza el campo `apiKeys` o `webhooks` y `revision` en `platform/usage` dentro de la misma transacción. Un restaurante sin límites configurados falla cerrado. Coordinar estos campos con `assertPlatformCapacity` de Billing al integrarlo; no usar `platformRestaurantUsage` para autorizar altas. Caducadas/revocadas liberan cuota; suspendidos cuentan. Revocados no se reactivan, se crea otro destino. La API verifica fecha de suscripción actual y módulo en cada petición, además de scopes/locales. Contadores privados de minuto: `platform/apiRate_<keyId>` y `platform/apiRate_restaurant` (60 y 300). No producen actividad por petición.

`measureUsage` guarda mediciones con Timestamp y retorna ms. `UsageSnapshot` añade solo cuatro campos opcionales: `activeModules`, `moduleOverrides`, `legacyPlan`, `platformRevision` (versión de entitlements). El listado añade opcionalmente `workerLastRunAt` y `lastAttemptAt` para mostrar ejecuciones e intentos reales. El panel distingue medido de directo; `pendingCommands` cuenta streams bloqueados ya conocidos en el servidor. No conoce intenciones solo locales. `platform/apiHealth` guarda última ejecución del trabajador y transporte; el panel de entregas advierte que el trabajador local es explícito y que encolar no acredita entrega.

El worker procesa páginas de 100 eventos, de 100 endpoints por evento y de 100 entregas debidas. El siguiente ciclo continúa los cursores de distribución. Ejecutar repetidamente si queda cola. `distributeEvents` solo modifica metadatos de distribución, conserva el payload del evento. Entregas tienen lease de 30 segundos con id de propietario, timeout HTTP total de 10 segundos, 12 intentos por ronda y registro sin cuerpos de respuesta. Una entrega suspendida espera revisión; repetir exige motivo y conserva cuerpo e id. El transporte HTTPS fija el DNS verificado a la conexión y no sigue redirecciones. En emuladores no sale HTTP externo. `probar-receptor` inyecta un transporte que acepta un único destino lógico y envía exclusivamente al receptor de la fila en loopback.

## Productores pendientes, sin promesas de eventos inexistentes

Los archivos de reservas, sala y caja pertenecen a otras filas/fases. El coordinador debe insertar el siguiente servicio tras todas las lecturas y en la misma transacción que el efecto y su recibo idempotente:

```ts
enqueuePlatformEvent(tx, {
  id: sha256Hex(JSON.stringify([restaurantId, decisionId, eventType, entityId])),
  version: 1, type: eventType, restaurantId, locationId, occurredAt: now,
  data: { entityId, status },
})
```

`decisionId` debe ser la revisión/clave ya confirmada y recuperable de esa decisión, no aleatorio en cada reintento ni `Date.now()` como identidad. El servicio usa `tx.create`: si la decisión ya se recupera de su recibo, no volver a encolarla. No llamarlo desde un disparador posterior y anunciar atomicidad. Puntos: creación/transición de reserva, `Context.flush` de fase 2 para pedidos y líneas tras reconciliar cambios, decisión de pago confirmado en caja y trabajadores Billing/privacidad. No se ha editado ninguno. Los productores no están conectados en esta entrega. La prueba local genera un evento identificado como verificación, sin crear una comanda ni fingir un cobro.

## Soporte y Billing

`abrirAccesoSoporte` exige el claim real, motivo y 1 a 60 minutos, registra actor y actividad. No cambia claims ni concede acceso a contactos, claves o cuerpos; no existe un explorador Admin. Un consumidor futuro debe comprobar de nuevo claim, actor, restaurante y caducidad. El panel actual registra la intervención y explica estos límites.

El editor antiguo de plan sigue usando `cambiarPlan` en restaurantes no migrados; los migrados usan `cambiarExcepcionesPlataforma` con revisión y motivo, que entrega la fila de Billing. Esta última operación queda pendiente de su registro por el coordinador. La pantalla no ofrece modificar el precio ni activar una suscripción ficticia. Los límites demo proceden del catálogo provisional y no migran restaurantes antiguos. Sin claves de Stripe Billing no se cobra nada.

## Arranque local y verificación

Exportar `GCLOUD_PROJECT=demo-llenamos`, `FIRESTORE_EMULATOR_HOST=127.0.0.1:8097`, `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103`. Crear config ignorada `firebase.agente2.json` desde firebase.json con puertos de la fila. Para no abrir el websocket Firestore fuera de la fila, en esta máquina se ha desactivado UI y usado `emulators.firestore.websocketPort=4012`. Hub 4412, logging 4512, Eventarc 9312 y Tasks 9512. Aislar credenciales con `XDG_CONFIG_HOME=/tmp/llenamos-panel-config` si el CLI intenta escribir en una ruta de solo lectura.

```sh
pnpm --filter functions exec tsup --config src/fase6-api/emulador.config.ts
npx firebase emulators:start --project demo-llenamos --config firebase.agente2.json
pnpm seed
pnpm seed:servicio
pnpm exec tsx scripts/plataforma-api-local.ts preparar-demo
pnpm exec tsx scripts/plataforma-api-local.ts medir
pnpm exec tsx scripts/plataforma-api-local.ts probar-receptor
```

`preparar-demo` solo establece límites configurables para `demo-lumbre`, no crea suscripción ni activa cargos. `worker` invoca el mismo trabajador con transporte externo bloqueado. `probar-receptor` usa 127.0.0.2:9512 si Tasks ocupa 127.0.0.1:9512, verifica firma y deduplicación con HTTP real local, y cierra su servidor al acabar.

Pruebas de integración en `functions/src/fase6-api/backend.integration.test.ts`; seguridad pura en `security.test.ts`; reglas en `tests/rules/fase6-api.test.ts`. Capturas y recorrido de navegador en `docs/diseno/capturas/panel-api/README.md`. El informe final registra los resultados reales.

