# Z1 · Panel general

Diseño «Sala cálida» aplicado a inicio, ajustes, equipo, actividad, mensajes, LogiQD y acceso. Cabecera `PageHeading` y resumen `SummaryStrip` en `components/common`, documentados en `componentes.md` y mostrados en `/panel/muestra`. Se conservan permisos, escrituras y callables.

Capturas reales de página completa con `require('playwright')` y `chromium.launch()`, todas a **2x**, con ventanas de escritorio **1440×900**, móvil táctil **390×844** y tableta táctil **1180×820**. Reloj real, zona Europe/Madrid, proyecto `demo-llenamos`, Next en `http://localhost:3011`. Solo se oculta el indicador de desarrollo de Next.

| Archivos | Contenido |
|---|---|
| `inicio`, `ajustes`, `equipo`, `actividad`, `mensajes`, `entrar` con sufijos `escritorio` y `movil` | Las seis pantallas del restaurante y el acceso |
| `equipo-invitar` y `mensaje-detalle`, escritorio y móvil | Ventana de invitación y texto real de un mensaje capturado |
| `logiqd`, `logiqd-plan`, `logiqd-sin-acceso`, escritorio y móvil | Restaurantes, edición de módulos y acceso restringido |
| `muestra-panel-general` | Las dos piezas comunes en la muestra, captura de la ventana |
| `inicio-tableta`, `equipo-tableta` | Resumen y gestión en tableta |
| `inicio-encargado-movil`, `equipo-encargado-movil`, `inicio-camarero-movil`, `ajustes-camarero-sin-acceso-movil` | Variación por rol y protección de ajustes |

## Repetir

Desde este worktree, configura `firebase.agente1.json` copiando `firebase.json` con los puertos de la fila 1: Auth 9102, Firestore 8096, Functions 5012, Storage 9212, UI 4011, Hub 4411, Logging 4511, Eventarc 9311 y Tasks 9511. Copia `.env.example` a `apps/web/.env.local` con `NEXT_PUBLIC_USE_EMULATORS=1` y los cuatro `NEXT_PUBLIC_*_EMULATOR_PORT` de esa fila.

```sh
npx firebase emulators:start --project demo-llenamos --config firebase.agente1.json
pnpm --filter web exec next dev --port 3011
```

En otra terminal, con ambos procesos listos:

```sh
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8096
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9102
pnpm seed
pnpm seed:servicio
node docs/diseno/capturas/z1-panel/preparar.cjs
node docs/diseno/capturas/z1-panel/comprobar.cjs
node docs/diseno/capturas/z1-panel/capturar.cjs
```

`preparar.cjs` confirma dos reservas y cancela una mediante las Functions locales, para generar confirmaciones y cancelaciones reales. El seed por sí solo no genera estos mensajes. Se capturan sin enviarlos. `comprobar.cjs` modifica y restaura datos de demostración; termina antes de ejecutar las capturas.

Los roles entran por `/entrar` con los botones de demo y contraseña `Llenamos2026!`. LogiQD entra por el formulario con la cuenta ya creada por el seed, `equipo@logiqd.test`, y la misma contraseña. No se crean cuentas externas.

Playwright se resuelve del entorno con `NODE_PATH` si hace falta. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` permite indicar Chromium existente. En esta sesión: `/home/gery/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell`. Sin dependencias añadidas. En el entorno con carpetas personales de solo lectura, se usaron `XDG_DATA_HOME=/tmp/z1-panel-data`, `XDG_CACHE_HOME=/tmp/z1-panel-cache` y, para Firebase, `XDG_CONFIG_HOME=/tmp/z1-panel-config` y `FIREBASE_EMULATORS_PATH=/home/gery/.cache/firebase/emulators`.

## Comprobaciones

- Propietario: validación y guardado de ajustes con recarga; cambio de rol; desactivación y reactivación mediante invitación de una cuenta existente; actividad con autor y paginación.
- Encargado: acceso a las pantallas autorizadas; no puede cambiar al propietario ni asignar su rol. Camarero: inicio disponible y ajustes, equipo, actividad y mensajes protegidos, también entrando por URL.
- Mensajes: búsqueda, filtros, orden, detalle con teclado, cierre al navegar y procesado real sin envío. LogiQD: activar Repite y restaurar el plan original con las funciones locales.
- Capturas sin desbordamiento horizontal ni errores de ejecución. Controles táctiles de al menos 44 px; selector de color e iconos de Z1 ampliados donde hacía falta.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` en verde: 753 pruebas (337 core, 347 web, 69 functions), 17 de integración omitidas por la configuración habitual. Las acciones anteriores se prueban aparte contra emuladores. No se han tocado funciones ni reglas. El build conserva el aviso previo de tamaño del bundle de la landing.

Decisión: tabla de LogiQD en escritorio y filas en móvil; Mensajes conserva filtros, orden por fecha y cliente, y paginación de 50 filas. Sin dependencias nuevas ni cambios fuera de Z1 y su muestra. Cambios sin commit ni push, según el encargo; los registra el coordinador. Mensaje propuesto: `Aplica Sala cálida al panel general y valida los accesos por rol`.

## Cierre del entorno

Se interrumpieron las sesiones de Next y Firebase (ambas terminaron con código 130). El aislamiento del ejecutor deja procesos hijos fuera de su espacio visible: `ss` sigue mostrando los puertos de la fila 1, pero `fuser` y `/proc` no permiten identificar a sus dueños. No se ha podido completar su apagado desde este entorno. **Pendiente para el coordinador desde el host:** detener exclusivamente los procesos de 3011, 9102, 8096, 5012, 9212, 4011, 4411, 4511, 9311 y 9511, y sus hijos de Firebase. No se ha intentado detener ningún servicio de otra fila.
