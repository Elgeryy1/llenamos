# Fusión de sala, carta, caja y cocina

Comprobación local del 9 de noviembre de 2026 en `fase2/completar-cocina`,
comparando `git show HEAD:<archivo>` y `git show origin/main:<archivo>` antes de
resolver los nueve archivos. No se ha modificado el índice ni hecho commit o push.

| Archivo con conflicto | Resolución |
|---|---|
| `ARQUITECTURA.md` | Conserva raciones y Web Push de cocina junto con borradores, solicitudes idempotentes y política horaria de sala; elimina las exclusiones antiguas que los contradecían. |
| `apps/web/src/lib/panel/nav.ts` | Conserva Disponibilidad, Comandas y Caja, con sus permisos y módulos. |
| `apps/web/src/lib/panel/nav.test.ts` | Une expectativas de entradas, roles y planes, incluida la exclusión de Caja sin `pos`. |
| `functions/src/fase2/backend.integration.test.ts` | Conserva todos los casos de ambas ramas, comprueba 34 callables y amplía el caso concurrente para verificar que el reintento idempotente no descuenta otra ración. |
| `functions/src/fase2/catalog.ts` | Conserva `guardarRaciones` y la recuperación, importación y revocación de QR, además de la custodia del secreto. |
| `functions/src/fase2/context.ts` | Lee tanto `pushSubscriptions` como `takeawaySecrets`, manteniendo los mensajes de recogida. |
| `functions/src/fase2/index.ts` | Conserva las exportaciones de ambas ramas y el registro transaccional `orderSubmissions`; excluye de reconciliación y actividad tanto `configuracionPush` como `recuperarQrMesa`. |
| `functions/src/fase2/public.ts` | El QR marcha todo y conserva la comprobación `expectedPrices`, destino y horario. |
| `functions/src/fase2/tasks.ts` | Conserva la protección de la tarea de marcha con retenidos y la revisión de recogida mediante `expectedLineIds`. |

No se añaden dependencias ni firmas nuevas al contrato combinado. Se conservan
las pruebas y exportaciones de ambas ramas. El índice seguirá indicando los
archivos como `UU` hasta que el coordinador los añada y cierre la fusión.

## Comprobaciones

- `pnpm install` y `pnpm funciones:build`: correctos.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build`: correctos tras la resolución final. Core 396 pruebas, web 480 y functions 76. Sin emuladores se omiten las suites de integración correspondientes.
- Integración de fase 2: 5 archivos y 60 pruebas aprobadas, sin omisiones.
- Reglas de Firestore y Storage: 2 archivos y 78 pruebas aprobadas.
- `git diff --check` y búsqueda de marcadores en los archivos de git: sin incidencias.
- Tres recorridos de Chromium con los emuladores reales: cocina, avisos y navegación combinada. Sin errores de página en la navegación de Comandas, Disponibilidad y Caja.

Todo usa `demo-llenamos` y los puertos de la fila 4: Auth 9105, Firestore 8099,
Functions 5015, Storage 9215, websocket 4014, Hub 4414, Logging 4514,
Eventarc 9314, Tasks 9514 y web 3014. La interfaz de emuladores permanece
desactivada en la configuración local existente. Se han parado los procesos
iniciados para estas comprobaciones y verificado que sus puertos quedan libres.

## Repetir los recorridos

Configurar `firebase.agente4.json` y `apps/web/.env.local` con la fila 4. Si el
aislamiento impide preparar pnpm, usar `XDG_DATA_HOME=/tmp/llenamos-pnpm4/data`
y `XDG_CACHE_HOME=/tmp/llenamos-pnpm4/cache`. Para Firebase se ha usado
`XDG_CONFIG_HOME=/tmp/llenamos-firebase4 TMPDIR=/tmp/llenamos-fusion4/temp`, con
esas carpetas creadas, para evitar escribir credenciales fuera del worktree.

Arrancar los emuladores, ejecutar `pnpm seed` y `pnpm seed:servicio` con
`GCLOUD_PROJECT=demo-llenamos`, `FIRESTORE_EMULATOR_HOST=127.0.0.1:8099` y
`FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9105`, y abrir la web con
`pnpm --filter web exec next dev --port 3014`. Las cuentas se eligen en `/entrar`
con contraseña `Llenamos2026!`.

```bash
CAPTURAS_DIR=docs/diseno/capturas/fusion-cocina node scripts/e2e-completar-cocina.cjs
CAPTURAS_DIR=docs/diseno/capturas/fusion-cocina node scripts/e2e-avisos-local.cjs
node scripts/e2e-fusion-cocina.cjs
```

El segundo recorrido requiere las claves VAPID locales ya descritas en
`../completar-cocina/README.md`. Los avisos siempre se capturan en el emulador;
el evento del trabajador de Chromium es sintético y no contacta con proveedores.
El tercer recorrido habilita `pos` temporalmente en la demo para comprobar Caja
y restaura los módulos originales al terminar. Solo comprueba navegación y
lectura de la pantalla de Caja; no realiza cobros ni emisión fiscal.

```bash
TEST_FIREBASE_EMULATORS=1 GCLOUD_PROJECT=demo-llenamos FIRESTORE_EMULATOR_HOST=127.0.0.1:8099 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9105 pnpm --filter functions exec vitest run src/fase2
```

Con los emuladores anteriores parados:

```bash
npx firebase emulators:exec --project demo-llenamos --config firebase.agente4.json --only firestore,storage "vitest run --root tests/rules"
```

## Capturas

Todas proceden de contextos con `deviceScaleFactor: 2`, sin imágenes simuladas.

| Capturas | Qué comprueban |
|---|---|
| `menu-comandas.png`, `menu-disponibilidad.png`, `menu-caja.png` | Las tres entradas conviven en el menú y sus pantallas abren. |
| `cocina-escritorio.png`, `cocina-tableta.png`, `cocina-movil.png` | Rejilla de cocina a 1440 × 900, 1180 × 820 y 390 × 844. |
| `pases-en-espera.png`, `seleccion-ticket.png`, `barra-nota.png` | Retenidos, acciones múltiples por estación y notas comunes. |
| `impresion-ticket.png`, `ticket-recogida.png` | Documento de impresión operativo y datos de recogida. |
| `raciones-agotadas.png` | Solo un envío consume la última ración concurrente. |
| `movil-tarea-retenida.png`, `movil-avisos-configurados.png` | Tarea de marcha con responsable y estado de avisos locales. |
| `movil-avisos-captura-local.png`, `movil-aviso-silenciado.png` | Permiso, trabajador, evento sintético y silencio tras reclamar. |

`recorrido.json` y `avisos-local.json` registran las verificaciones sin secretos.
Siguen pendientes las validaciones de dispositivos físicos y proveedor push real
documentadas en el cierre de cocina; esta fusión no las da por probadas.

Pendiente de esta entrega: el coordinador añade los archivos resueltos al índice
y cierra la fusión. Mensaje propuesto:
`Fusionar sala, carta y caja conservando el cierre de cocina`.
