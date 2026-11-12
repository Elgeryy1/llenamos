# Pago móvil y recibo digital

Trabajo de `fase3/pago-movil`, fila de puertos 5. Cambios sin commit ni push. Al revisar la rama no existía el commit «Trabajo en curso»: `git log origin/main..HEAD --stat` estaba vacío y HEAD era `4c4cfe9`.

## Entrega

Cuenta móvil con marca del restaurante, selección de una parte ya preparada desde QR, propina voluntaria separada, consentimiento independiente del correo, solicitud de factura completa y regreso de Checkout sin confirmar pagos por URL. Castellano, catalán e inglés; controles de 48 px, diseño Sala cálida. Sin claves ni conexión con caja, la página dice que no se ha cobrado nada y deshabilita continuar.

Cinco callables del contrato, dos aditivas para elegir parte desde mesa, `stripeCuentaWebhook` independiente de señales y reconciliador. Stripe por fetch, sin SDK; HMAC sobre cuerpo original, tolerancia de cinco minutos, control de cuenta Connect, sesión, moneda, total, propina y modo. Reservas transaccionales, eventos durables, recuperación de creación incierta con idéntica petición, incidencias tardías y factura pendiente sin repetir cobro.

El recibo tiene token distinto del QR y del pago, caducidad de 30 días y salida fiscal filtrada. No muestra ids internos, notas, otras partes ni correo. Su QR fiscal M se genera localmente y se ha leído con ZXing desde la captura real. El correo pasa por la cola existente; sin proveedor se distingue `captured` de `sent`. La muestra fiscal dice **«no válido para Hacienda»**. Las facturas de las capturas son fixtures identificadas como prueba, no ventas, cobros ni facturas reales.

## Probar en local

Requiere Node y Java 21. No hay dependencias nuevas de proyecto. Si pnpm intenta escribir fuera de la caja de seguridad, usar `PNPM_HOME=/tmp/llenamos-pnpm XDG_RUNTIME_DIR=/tmp/pago-runtime`; crear este último directorio antes. La instalación de esta revisión se hizo con `--frozen-lockfile --store-dir /tmp/pago-store`, sin cambiar el lockfile.

```bash
pnpm exec tsx scripts/pago-movil-preparar-local.ts
pnpm funciones:build
pnpm --filter functions exec tsup --config src/fase3-mobile/tsup.local.ts
XDG_CONFIG_HOME=/tmp/pago-config npx firebase emulators:start --project demo-llenamos --config firebase.agente5.json
```

`firebase.agente5.json`, los `.env.local` y `functions/lib` están excluidos de git. El script solo prepara la fila 5 y un secreto HMAC público de ejemplo; **no pone STRIPE_SECRET_KEY**. El CLI de Firebase necesita un websocket adicional para Firestore: se utiliza el puerto propio 4015 y se apaga la UI, evitando abrir puertos ajenos al reparto. Auth 9106, Firestore 8100, Functions 5016, Storage 9216, Hub 4415, Logging 4515, Eventarc 9315, Tasks 9515 y web 3015.

En otra terminal, siempre en este worktree:

```bash
export GCLOUD_PROJECT=demo-llenamos
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8100
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9106
export FUNCTIONS_EMULATOR=true
export PUBLIC_APP_URL=http://localhost:3015
pnpm seed
pnpm seed:servicio
pnpm exec tsx scripts/pago-movil-seed.ts
pnpm --filter web exec next dev --port 3015
```

Abrir `/entrar`, `propietario@lumbre.test`, contraseña `Llenamos2026!`. El fixture móvil vive en otro restaurante de prueba y no modifica el servicio de Taberna Lumbre. Los enlaces están en `/tmp/pago-movil-links.json`.

```bash
pnpm exec tsx scripts/pago-movil-capturas.ts
pnpm exec tsx scripts/pago-movil-firmas.ts
TEST_FIREBASE_EMULATORS=1 pnpm --filter functions exec vitest run
npx firebase emulators:exec --project demo-llenamos --config firebase.agente5.json --only firestore,storage "vitest run --root tests/rules"
```

Para `emulators:exec`, parar primero los emuladores propios; las pruebas de reglas borran los datos de demo. Parar al final los PID propios de web/emuladores. El build normal restaura la entrada común de `functions/lib`: recompilar la entrada local antes de arrancar Functions para probar móvil.

## Capturas reales a 2x

Comprobaciones realizadas: `pnpm lint`, `pnpm typecheck`, `pnpm test` y `pnpm build`; integración general de Functions con **137 pruebas** en los emuladores de la fila 5, incluidas las **19 del móvil**; reglas de Firestore y Storage con **78 pruebas**. Las suites que exigen otros indicadores de entorno siguen omitiéndose según su configuración original. Webhook HTTP: firma válida y repetida 200, mala y caducada 400. Navegador real con login demo y nueve capturas, sin errores de página. La URL del QR capturado se decodificó localmente con ZXing y coincidió con el original. Al entregar se han detenido los procesos propios y comprobado que todos los puertos de la fila 5 están cerrados; no quedan controles temporales de cierre en el código.

| Archivo | Vista |
|---|---|
| `cuenta-movil.png` | Cuenta y aviso sin Stripe a 390 × 844 |
| `propina-y-recibo-movil.png` | Propina del 5 %, consentimiento y correo |
| `cuenta-catalan-movil.png` | Cuenta en catalán |
| `cuenta-ingles-movil.png` | Cuenta en inglés |
| `partes-movil.png` | Selección de parte preparada desde el token de mesa |
| `recibo-movil.png` | Factura de prueba, QR y correo capturado |
| `enlace-invalido-movil.png` | Rechazo de token ajeno |
| `cuenta-escritorio.png` | Cuenta a 1440 × 900 |
| `recibo-escritorio.png` | Recibo a 1440 × 900 |

Las respuestas de Firebase no se interceptan ni se sustituyen. El script bloquea solicitudes externas, comprueba ausencia de desbordamiento, errores de página, botón deshabilitado y datos privados ajenos. Solo oculta el indicador de desarrollo de Next para las capturas. El correo de muestra se procesa por el consumidor real en modo emulador y queda capturado, no enviado.

## Integración que debe hacer el coordinador

El backend de caja de la otra rama **no está en este worktree**. La integración móvil con Firestore sí se prueba; `confirmExternalPayment` e `issuePartInvoice` se inyectan como dobles identificados en esas pruebas, verificando sus entradas y sin implementar otro ledger. Falta probar esos dos servicios reales al integrar las ramas. Hasta conectarlos no se ofrece cobrar, aunque hubiera claves.

En `functions/src/index.ts`, además de exportar el índice móvil, conectar al inicio:

```ts
import { connectCajaServices } from './fase3-mobile/backend'
import { confirmExternalPayment, issuePartInvoice } from './fase3/service'
connectCajaServices({ confirmExternalPayment, issuePartInvoice })
export * from './fase3-mobile/index'
```

La reserva usa `paymentReservations/{partId}` y conserva `checkoutId`, revisión, principal y caducidad externa. Caja debe comprobarla también cuando su reloj haya vencido: **solo una respuesta externa terminal o el registro confirmado libera el saldo**. El backend es dueño de pagos, saldo, facturas, correlativos, actividad fiscal y liberación tras cobro. Móvil no escribe ninguno de esos libros.

El coordinador conecta enlaces desde `/m/**` a `/p/{slug}/{locationId}/mesa/{tableId}?t=…` y el botón del personal con `crearEnlaceCobro`; no se han editado navegación, caja ni QR compartidos. También debe mostrar `mobileIncidents` al encargado y aplicar en la configuración común los encabezados `Referrer-Policy: no-referrer`, `Cache-Control: no-store` y `X-Robots-Tag` a los documentos HTML de `/p/**` y `/recibo/**`. Las páginas ya tienen metadatos equivalentes y las callables devuelven esos encabezados.

## Reglas e índices como datos para el backend

No se ha editado `firebase/**`. Mantener lectura y escritura SDK denegadas para `mobileCheckouts`, `digitalReceipts`, `mobileRequests`, `mobileStripeEvents`, `paymentReservations` y `restaurants/{rid}/mobileRateLimits`. `mobileIncidents`: solo owner/manager activo, local permitido y `pos`, lectura de gestión; ninguna escritura de cliente. El público solo consulta callables con credenciales exactas. Los índices de pago de caja siguen perteneciendo a su agente.

| Grupo | Campo | Ámbito necesario |
|---|---|---|
| `mobileCheckouts` | `needsReconciliation` ascendente | collection group y colección |
| `mobileStripeEvents` | `status` ascendente | collection group y colección |

Las demás consultas son índices simples ordinarios: restaurante por `slug`, partes por `billId`, cajas por `status`, sesiones por `tableIds` array contains. No se necesita índice compuesto nuevo. Los contadores llevan `expiresAt`; la política de limpieza/retención de contadores, eventos y resultados privados debe integrarse sin borrar prueba de un pago incierto. Nunca habilitar TTL sobre reservas de saldo como mecanismo de liberación.

## Configuración y decisiones

Quién cobra sigue por decidir. Adaptador por entorno:

- `STRIPE_MOBILE_MODE=single`: cuenta de la clave de LogiQD o de la instalación, sin cabecera Connect.
- `STRIPE_MOBILE_MODE=connect`: JSON privado `STRIPE_CONNECTED_ACCOUNTS={"restaurantId":"acct_…"}`, con cargo directo y cuenta fijada por restaurante. Nunca procede del móvil.
- `STRIPE_SECRET_KEY`, `STRIPE_MOBILE_WEBHOOK_SECRET` separado de señales, `PUBLIC_APP_URL` HTTPS fuera del emulador. Sin SDK. En demo/emuladores el adaptador bloquea Stripe real incluso si se pusiera una clave; las pruebas inyectan fetch.

No se elige proveedor fiscal ni se declara validez para Hacienda. No se ha probado con Stripe real, Resend real ni proveedor fiscal. La selección del receptor de fondos y la integración de devoluciones siguen en el backend/coordinador.

Cambio mínimo y aditivo de core: `digital_receipt` en el catálogo de mensajes y su asunto traducido. **Sin cambios en `packages/core/src/caja/**` ni `api-caja.ts`.** Las ampliaciones locales de API y las dos callables QR están descritas en ARQUITECTURA.md. Ninguna dependencia nueva de proyecto; qrcode y ZXing se instalaron solo en `/tmp` para contrastar y leer el QR, fuera de package.json y lockfile.

Mensaje de commit propuesto: `Añade pago móvil por partes con Stripe, reconciliación y recibo privado`.
