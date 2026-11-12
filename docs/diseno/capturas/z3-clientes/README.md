# Z3 · Clientes

Clientes, su ficha, lista de espera e importar con el sistema **Sala cálida**. Capturas reales de Chromium con `require('playwright')` y `chromium.launch()`, proyecto local `demo-llenamos`, web 3015 y emuladores de la fila 5. Entrada por los botones de demo de `/entrar`, contraseña `Llenamos2026!`. Reloj real del 9 de noviembre de 2026, Europe/Madrid.

Las **18 imágenes son a 2x**: escritorio 1440×900, móvil táctil 390×844 y tableta táctil 1180×820. Las vistas previas de importación, el resultado y las listas de espera de móvil y tableta son de página completa.

| Archivos | Qué enseñan |
|---|---|
| `clientes-{escritorio,movil,tableta}.png` | Tabla ordenable o filas táctiles, buscador, avatar y etiquetas |
| `ficha-{escritorio,movil,tableta}.png` | Contacto, estadísticas, preferencias e historial con punto y palabra |
| `lista-espera-{escritorio,movil,tableta}.png` | Oferta con plazo, grupos esperando y reserva aceptada |
| `lista-espera-vacia.png` | Día siguiente sin entradas |
| `importar-{escritorio,movil,tableta}.png` | Inicio de la importación |
| `importar-xlsx-{escritorio,movil,tableta}.png` | Lectura real de la primera hoja del Excel de `tests/fixtures/` |
| `importar-resultado-escritorio.png`, `muestra.png` | Resultado de una importación real y las piezas nuevas del catálogo |

Para repetir, configura `.env.local` y `firebase.agente5.json` según la fila 5: Auth 9106, Firestore 8100, Functions 5016, Storage 9216, UI 4015, Hub 4415, Logging 4515, Eventarc 9315 y Tasks 9515. Arranca los procesos en terminales separadas desde este worktree:

```sh
# Las rutas temporales evitan escribir en directorios de herramientas de solo lectura.
export XDG_DATA_HOME=/tmp/llenamos-z3-data XDG_CACHE_HOME=/tmp/llenamos-z3-cache
XDG_CONFIG_HOME=/tmp/llenamos-z3-config npx firebase emulators:start --project demo-llenamos --config firebase.agente5.json
pnpm --filter web exec next dev --port 3015
```

Con ambos listos, en otra terminal:

```sh
export XDG_DATA_HOME=/tmp/llenamos-z3-data XDG_CACHE_HOME=/tmp/llenamos-z3-cache
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8100 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9106
pnpm seed
pnpm seed:servicio
node docs/diseno/capturas/z3-clientes/preparar.cjs
node docs/diseno/capturas/z3-clientes/capturar.cjs
```

Playwright se resuelve del entorno con `NODE_PATH` si hace falta, sin instalar dependencias. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` permite indicar el Chromium disponible. `preparar.cjs` añade tres entradas de demostración para mostrar los estados de espera. El recorrido importa una reserva por propietario y encargado, verifica su documento y restaura las preferencias editadas. Solo oculta el indicador de desarrollo de Next al fotografiar.

Comprobado con propietario, encargado y camarero: leer clientes y espera, editar notas, alergias y etiquetas, validación de etiquetas y `updatedBy` correcto. Propietario y encargado: comprobar disponibilidad, filtrar errores e importar sin repetir filas ya creadas. Camarero: importar denegado también por URL directa. Además: búsqueda por teléfono, ordenación por visitas, apertura con Intro, cambio de día, lectura de `.xlsx`, carga de más clientes, controles de 44 px, guardado de 48 px y ausencia de desbordes y errores de ejecución.

`pnpm lint && pnpm typecheck && pnpm test && pnpm build` en verde: **753 pruebas** (337 core, 347 web, 69 functions), con 17 de integración omitidas por la configuración habitual. Aviso previo de tamaño de un chunk de la landing. Sin cambios en funciones, reglas, core o `lib/`, ni dependencias nuevas. Las tablas administrativas se conservan en escritorio; móvil usa filas. `SummaryStrip` y `CustomerBadges` están en `common`, documentadas y en `/panel/muestra`. Sin pendiente funcional. Cambios sin commit ni push, listos para revisión del coordinador.

Pendiente de entorno: las sesiones de web y emuladores terminaron con señal de interrupción (130), pero sus procesos hijos siguen escuchando. `fuser` no puede verlos desde el espacio de procesos de esta caja. Hay que detenerlos desde el host, exclusivamente en los puertos de la fila 5; Firebase también reservó automáticamente 9151 para el websocket de Firestore. No se han detenido servicios de otras filas.
