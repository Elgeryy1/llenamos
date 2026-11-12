> **Integrado** (rama `fase6/integracion`): exportaciones, guarda de `reservationChanged`, rechazo de recibos suprimidos y regla de `invoices` (`get` restringido; el listado no puede restringirse por documento). Ver «Integración de la fase 6» en ARQUITECTURA.md.

# Fragmentos para el coordinador

No se ha editado `firebase/**`, `functions/src/index.ts` ni la navegación.

## Índice común

```ts
export { registrarConsentimiento, solicitarPrivacidad, verificarSolicitudPrivacidad, descargarExportacionPrivacidad, listarSolicitudesPrivacidad, privacyDownload } from './fase6-privacy'
export { privacidadProgramada } from './fase6-privacy/process'
```

El disparador `reservationChanged` actual reconstruye una ficha al modificar reservas. Antes de parsear `event.data`, integrar:

```ts
import { isPrivacyRedacted } from './fase6-privacy'
if (isPrivacyRedacted(event.data?.after.data()) || isPrivacyRedacted(event.data?.before.data())) return
```

La entrada local `emulator-entry.ts` ya usa este guard. Es imprescindible integrarlo antes de activar el borrado en la entrada común. Los productores de campañas futuros deben llamar `assertMarketingConsent` dentro de su transacción al encolar y volver a comprobar al reclamar el envío. No hay campañas o Repite conectados en esta rama.

Los adaptadores de recibos `orderSubmissions`, `posRequests` y `syncReceipts` conservan id, huella, secuencia e importes. Si `privacyRedacted === true`, los recuperadores deben rechazar la recuperación del cuerpo personal con `failed-precondition` sin ejecutar otra vez. Nunca borrar esa barrera ni reinterpretar la respuesta saneada como un envío nuevo. La fila sin conexión debe integrar este guard en sus recuperadores.

## Firestore

Las colecciones nuevas carecen de permiso SDK y las reglas actuales las deniegan por defecto. Mantenerlo para `consents`, `privacyEvidence`, `privacyJobs`, `privacyRequests`, `privacyDownloads`, `privacyTombstones`, `privacyHealth`, `privacyRestrictedInvoices`, `restoreSandbox` y sus descendientes. No añadir comodines de lectura para LogiQD.

Sustituir únicamente la lectura de `invoices` por este fragmento en `restaurants/{rid}/locations/{lid}`:

```rules
match /invoices/{id} {
  allow read: if posReader(rid,lid)
    && (!exists(/databases/$(database)/documents/restaurants/$(rid)/locations/$(lid)/privacyRestrictedInvoices/$(id)) || manages(rid));
}
```

El trabajador escribe la restricción separada, sin alterar el original fiscal. La suite `fase6-privacy.test.ts` comprueba las reglas actuales para los datos privados y este fragmento incorporado en memoria para la factura conservada. La regla fiscal queda pendiente de integración; con las reglas originales, un camarero con caja sigue pudiendo leer esa factura.

## Storage

Mantener denegación por defecto para `platform/{rid}/exports/**`, `platform/{rid}/backups/**` y `restore-drills/**`. Ningún token público de descarga. El endpoint local `privacyDownload` exige ticket opaco, permiso actual, trabajo vigente y consumo transaccional de un uso; las callables requieren sesión para emitirlo.

## Índices

Solo consultas de igualdad de un campo (`customerId`, `restaurantId`) u orden por id. No se requiere índice compuesto adicional.

## Menú como datos

```json
{ "href": "/panel/privacidad", "label": "Privacidad", "permission": "privacidad.gestionar", "group": "Gestionar", "icon": "ShieldCheck" }
```

Propietario y encargado con acceso a todos los locales. No exige un módulo operativo activo. La comprobación de locales del servidor es más restrictiva que la del permiso de interfaz. El claim `logiqd` se rechaza aunque exista una membresía por error; tampoco puede canjear tickets de descarga anteriores. El endpoint comprueba que la cuenta siga activa y no pertenezca a LogiQD.

## Custodia productiva (2026-11-10)

La configuración se valida antes de leer/escribir: proyecto real, ausencia de emuladores,
`PLATFORM_CUSTODY_ENABLED=1`, `PLATFORM_DATA_BUCKET` del mismo proyecto y secreto
`PLATFORM_DATA_KEY_V1` (32 bytes en base64 canónico), enlazado en cada función mediante
Secret Manager. Los archivos siguen privados y autenticados por AES-GCM con ámbito de ruta.
Las cuentas de servicio necesitan IAM mínimo en ese bucket; la configuración por sí sola no
garantiza ni configura IAM ni una política de conservación legal.
