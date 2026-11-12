# Z4 · Web pública

53 capturas reales de Chromium a 2x y 18 comprobaciones, con la web y Firebase locales (`demo-llenamos`).
Escritorio 1440×900, móvil táctil 390×844 y reserva en tableta 1180×820.
Los PNG muestran el área visible; `horas` recoge la sección al desplazarse.
Solo se oculta el indicador de desarrollo de Next.

## Pantallas

Cada nombre lleva el sufijo `escritorio` o `movil`:

- `reservar`, `horas`, `calendario`, `datos`, `datos-errores`.
- `confirmada`, `pendiente`, `cancelar`, `cancelada`, `cancelar-marca`.
- `lista-espera`, `lista-inscrita`, `oferta`, `oferta-caducada`.
- `senal-pendiente`, `senal-no-configurada`, `senal-aviso`.
- `enlace-incompleto`, `no-disponible`.
- `widget`, `widget-ca`, `widget-en`, `widget-incrustado`.

Además: `widget-modal-escritorio`, `widget-ventana-movil`, `oferta-aceptada-movil`,
`widget-confirmada-movil`, `widget-datos-errores-movil`, `reservar-tableta` y `muestra-escritorio`.

## Repetir

Desde este worktree, con las dependencias instaladas y `pnpm funciones:build` hecho:

```sh
# Terminal 1: configuración local excluida de git, puertos de la fila 2.
PUBLIC_APP_URL=http://localhost:3012 npx firebase emulators:start --project demo-llenamos --config firebase.agente2.json
# Terminal 2: .env.local de la web con Auth 9103, Firestore 8097, Functions 5013 y Storage 9213.
pnpm --filter web exec next dev --port 3012
# Terminal 3
FIRESTORE_EMULATOR_HOST=127.0.0.1:8097 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103 pnpm seed
FIRESTORE_EMULATOR_HOST=127.0.0.1:8097 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103 pnpm seed:servicio
FIRESTORE_EMULATOR_HOST=127.0.0.1:8097 pnpm exec tsx docs/diseno/capturas/z4-publica/preparar.ts
node docs/diseno/capturas/z4-publica/capturar.cjs
```

Playwright se carga con `require('playwright')`, sin añadir dependencias. Si está instalado
fuera del proyecto, indica su `node_modules` con `NODE_PATH`. `CHROMIUM_PATH` permite elegir
el Chromium ya instalado. En este entorno se usó Chromium 1248 de la caché de Playwright.
Para evitar escrituras fuera del worktree, se usaron `XDG_DATA_HOME=/tmp/llenamos-z4-data`
y `XDG_CONFIG_HOME=/tmp/llenamos-z4-config` al ejecutar pnpm y Firebase.

La fila no reserva un puerto adicional para el websocket de Firestore. La configuración
local deja la UI desactivada y usa 4012 para ese websocket; Hub 4412, Logging 4512,
Eventarc 9312 y Tasks 9512. No se usa ningún puerto de otra fila.

## Datos y comprobaciones

`seed` y `seed:servicio` preparan Taberna Lumbre. `preparar.ts` añade otro restaurante
de demostración con marca verde y referencias válidas, aislado del servicio del panel.
La oferta nace de cancelar una reserva y el enlace sale del mensaje capturado.
Los estados de señal requerida e inactiva se siembran para comprobar su presentación:
no representan un cobro. No hay claves ni llamadas a Stripe. La página anfitriona de
`widget.js` es HTML de ejemplo servido localmente por Playwright.

`comprobaciones.json` guarda el resultado: reserva y cancelación reales, confirmación de
asistencia, ICS, copia del enlace, foco seguro al cancelar, lista de espera, aceptación y
caducidad de oferta, señal sin proveedor, tres idiomas y widget en sus tres modos.
Propietario, encargado y camarero entran con los botones de demo de `/entrar`
(`Llenamos2026!`), leen reservas, abren el alta y consultan el enlace público con sesión.
Se comprueba que ni la página ni el iframe desbordan y que no hay errores de página.

Validación del repositorio: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` en verde.
753 pruebas pasan; las 17 pruebas de integración que el comando ordinario omite siguen
omitidas. No se han cambiado funciones ni reglas. Sin dependencias nuevas.

Decisiones: superficies cálidas, radios de 12 px, acciones de 48 px, dos columnas solo en
escritorio y acento del restaurante. `SummaryList` está en `common`, documentada y visible
en `/panel/muestra`. Lógica e idiomas conservados. Queda fuera el cobro contra Stripe real.

Cierre del entorno: Firestore quedó detenido. Los lanzadores terminaron, pero sus procesos
Node siguen escuchando y no son visibles desde el espacio de procesos aislado de esta caja.
El coordinador debe cerrarlos desde el host, solo en los puertos de esta fila:
`fuser -k -TERM -n tcp 3012 9103 5013 9213 4412 4512 9312 9512`.
