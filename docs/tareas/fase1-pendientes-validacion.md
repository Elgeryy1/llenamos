# P · Pendientes de la fase 1

Validación local del 9 de noviembre de 2026, rama `fase1/pendientes`, proyecto `demo-llenamos`. Sin despliegues, proveedores reales, cuentas nuevas ni pagos. Se conservan los commits heredados y se completa su comprobación. No se cambia el diseño del panel.

## Qué queda probado

- Lista de espera: cancelar con `cambiarEstadoReserva`, ofrecer a la primera entrada compatible, capturar el mensaje con su enlace, reservar capacidad, rechazar tokens falsos y repetidos, aceptar y consultar la nueva reserva, caducar y ofrecer a la siguiente persona. La caducidad se fuerza cambiando `expiresAt`, sin esperar treinta minutos ni alterar el reloj del sistema.
- Stripe: reserva pública pendiente, señal requerida solo con clave ficticia dentro del proceso de prueba, Checkout mediante `fetch` simulado e importe del servidor. El webhook HTTP recibe cuerpos firmados por HMAC con firma válida, incorrecta, caducada, futura y repetida. Comprueba sesión, céntimos y EUR, confirma una sola vez y no reabre reservas canceladas. Nunca se llama a Stripe real. El emulador no tiene `STRIPE_SECRET_KEY`.
- Sin Stripe: reserva pendiente y señal `not_configured`; Chromium comprueba el aviso de pago inactivo y la ausencia del botón de pagar.
- Excel: primera hoja por su relación en el libro, cadenas compartidas y en línea, celdas dispersas, fórmulas con valor guardado y fechas y horas de los sistemas 1900 y 1904. Fixtures reproducibles y válidas como paquete OOXML. Rechazo de archivos dañados, libros cifrados, descompresión excesiva con tamaño declarado falso y columnas desmesuradas. Sin biblioteca de Excel ni ZIP.
- Chromium: abre literalmente el enlace capturado, acepta, llega a la reserva y rechaza una oferta caducada y un enlace sin token. Inicia sesión con la cuenta local del seed y sube el `.xlsx` para comprobar tres filas válidas en la vista previa. No importa esas filas en la base de datos.

## Reproducir

Crear `firebase.agente2.json`, excluido de Git, copiando `firebase.json` con Auth 9103, Firestore 8097, Functions 5013, Storage 9213, UI 4012, Hub 4412, Logging 4512, Eventarc 9312 y Tasks 9512. No usar `--import`.

En `functions/.env.local`, también excluido de Git, solo secretos inventados:

```dotenv
WHATSAPP_APP_SECRET=r2-local-test
STRIPE_WEBHOOK_SECRET=r2-local-test
PUBLIC_APP_URL=http://localhost:3012
```

Dejar sin configurar las claves de Stripe, Resend y WhatsApp. Las pruebas de Checkout inyectan y retiran la clave ficticia con Vitest y sustituyen `fetch` antes de iniciar el pago.

```bash
pnpm install
pnpm funciones:build
npx firebase emulators:start --project demo-llenamos --config firebase.agente2.json
```

En otra terminal, con los emuladores activos:

```bash
export GCLOUD_PROJECT=demo-llenamos
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8097
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103
TEST_R2_EMULATORS=1 TEST_FIREBASE_EMULATORS=1 pnpm --filter functions test
pnpm fixtures:xlsx
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Para el navegador, copiar `apps/web/.env.example` a `.env.local`, activar los emuladores y poner `NEXT_PUBLIC_{AUTH,FIRESTORE,FUNCTIONS,STORAGE}_EMULATOR_PORT` a 9103, 8097, 5013 y 9213. Arrancar `pnpm --filter web exec next dev --port 3012`. Si se actualizan dependencias con Next en marcha, reiniciarlo y renovar su caché de desarrollo.

```bash
pnpm seed
pnpm seed:servicio
FUNCTIONS_EMULATOR_HOST=127.0.0.1:5013 WEB_URL=http://localhost:3012 pnpm e2e:lista-espera
```

Playwright usa la instalación existente, sin añadir una dependencia al proyecto. Si no se resuelve `require('playwright')`, indicar `PLAYWRIGHT_DIR` con la carpeta que contiene su `node_modules`. Si la revisión de Chromium instalada no coincide, indicar `CHROMIUM_PATH` al ejecutable existente. La prueba escribe capturas a 2x en [`docs/diseno/capturas/pendientes`](../diseno/capturas/pendientes/README.md).

Pruebas de reglas, con los emuladores anteriores detenidos:

```bash
npx firebase emulators:exec --project demo-llenamos --config firebase.agente2.json --only firestore "vitest run --root tests/rules"
```

En esta sesión los emuladores y Next ya venían arrancados por el agente anterior y se reutilizaron. El comando `emulators:exec` rechazó sus puertos ocupados. Se ejecutó la misma suite directamente con `FIRESTORE_EMULATOR_HOST=127.0.0.1:8097`, desactivando temporalmente los disparadores mediante el Hub 4412 y volviéndolos a activar al terminar. La suite limpia únicamente el Firestore de ese puerto. Los procesos heredados no son visibles en el espacio de procesos de esta sesión, por lo que no se han podido detener desde ella.

## Resultado

- `pnpm lint`, `pnpm typecheck`, `pnpm test` y `pnpm build`: correctos. Pruebas normales: 243 de core, 319 de web y 69 de funciones; las 17 de integración requieren sus variables explícitas.
- Integración con ambos indicadores activados: 86 pruebas de funciones correctas, ninguna omitida.
- Reglas: 56 pruebas correctas contra Firestore 8097.
- Seed y servicio de demostración correctos; Chromium completa todos los recorridos y genera ocho capturas.
- Node 24 del equipo y Java 21; compilación de funciones dirigida a Node 22. Antes de desplegar habrá que repetir en el runtime Node 22 y validar proveedores reales. No forman parte del trabajo local autorizado.

El directorio Git específico de este worktree está montado en solo lectura: `git add` no puede crear `index.lock`. Para conservar el trabajo y subirlo se usa un repositorio temporal en `/tmp`, con el mismo padre y los archivos de este worktree. El push es normal, sin forzar ni reescribir historia. El índice y HEAD locales permanecen en el commit heredado; los cambios visibles aquí corresponden al commit publicado en `origin/fase1/pendientes`.

## Dependabot

Consultado mediante `gh api repos/LogiQD/llenamos/dependabot/alerts`. Se han contrastado los rangos de las seis alertas abiertas con todas las versiones del lockfile actualizado: ninguna queda dentro de un rango vulnerable. Las alertas del repositorio se reevaluarán cuando estos cambios lleguen a su rama por defecto; no se han descartado manualmente.

| Alerta | Paquete | Versiones finales | Corrección |
|---|---|---|---|
| 6 | minimatch | 11.0.1; se conservan 3.1.5, 5.1.9 y 6.2.3, fuera del rango afectado | [Advisory del autor](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249) |
| 5 | glob | 14.0.2 | [Advisory del autor](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4) |
| 4 y 3 | @grpc/grpc-js | 1.14.7 | [Certificados](https://github.com/grpc/grpc-node/security/advisories/GHSA-m9gg-hp2v-232j), [mensajes de error](https://github.com/grpc/grpc-node/security/advisories/GHSA-f596-whhp-79r4) |
| 2 | @opentelemetry/core | 2.10.0 y 2.9.0 | [Advisory del proyecto](https://github.com/open-telemetry/opentelemetry-js/security/advisories/GHSA-8988-4f7v-96qf) |
| 1 | uuid | 11.1.1 | [Advisory del proyecto](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq) |

Las restricciones están en `pnpm-workspace.yaml`, mediante `overrides` acotados a versiones vulnerables, y en `pnpm-lock.yaml`. Se conserva uuid 11 con CommonJS; PubSub sigue disponiendo de `W3CTraceContextPropagator`. Se comprobó la carga de Firebase CLI, las API de glob y uuid, la integración de Firestore y las reglas tras actualizar. Sin dependencias directas nuevas; las actualizaciones transitivas incorporan las dependencias que necesitan las versiones corregidas.
