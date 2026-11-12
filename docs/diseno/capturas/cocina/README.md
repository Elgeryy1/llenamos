# Cocina y barra

Seis capturas reales a 2x con el proyecto local `demo-llenamos`, `pnpm seed` y `pnpm seed:servicio`. Entrada por `/entrar` con `cocina@lumbre.test` y `barra@lumbre.test`, contraseña `Llenamos2026!`. Escritorio 1440×900, tableta táctil 1180×820 y móvil táctil 390×844. Reloj real del restaurante.

`cocina-{escritorio,tableta,movil}.png` y `barra-{escritorio,tableta,movil}.png` enseñan el estado real de servidor pendiente: esta rama aún no tiene las reglas ni las callables de la fase 2. No hay pedidos de ejemplo ni respuestas interceptadas en el navegador. El script comprueba también el acceso cruzado entre roles, el propietario en ambas pantallas, el reintento, la ausencia de desbordamiento horizontal y los errores de ejecución.

## Repetir

Con `firebase.agente4.json` y `.env.local` configurados para la fila 4:

```sh
npx firebase emulators:start --project demo-llenamos --config firebase.agente4.json
pnpm --filter web exec next dev --port 3014
```

En otra terminal:

```sh
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8099
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9105
pnpm seed
pnpm seed:servicio
node docs/diseno/capturas/cocina/capturar.cjs
```

Playwright se resuelve del entorno, sin dependencias nuevas. Si es necesario, indicar `NODE_PATH` y `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Aquí se utilizó Chromium headless 1248 de la caché local. Por las restricciones de escritura del entorno, los comandos pnpm se ejecutaron con `XDG_DATA_HOME=/tmp/llenamos-cocina-data`, y Firebase con `XDG_CONFIG_HOME=/tmp/llenamos-cocina-config`, sin credenciales de nube.

## Comprobaciones

`pnpm lint && pnpm typecheck && pnpm test && pnpm build` en verde. 778 pruebas aprobadas: 337 de core, 372 de web y 69 de funciones. Hay 24 pruebas nuevas de cocina y barra. Las 17 pruebas de integración de funciones que omite su configuración habitual siguen omitidas; no se tocaron funciones ni reglas. El build conserva el aviso existente del tamaño de un chunk de la web de venta.

## Integración del coordinador

Datos para el menú común, que no se modifica en esta entrega:

| Sección | Ruta | Etiqueta | Grupo | Permiso | Módulos necesarios |
|---|---|---|---|---|---|
| cocina | /panel/cocina | Cocina | servicio | cocina.ver | floor y kitchen |
| barra | /panel/barra | Barra | servicio | barra.ver | floor y kitchen |

El campo común `module` puede usar `kitchen`; la página vuelve a exigir ambos módulos. Se recomienda añadir ambas rutas a `WIDE` en `PanelShell` para el ancho de servicio de 1600 px. Cocina y barra tienen su rol propio; propietario y encargado ven ambas.

Las pantallas escuchan `stations`, `settings/floor`, y `orderLines` con igualdad de `stationId`, `stationKind` y estados `held`, `fired`, `preparing`, `ready`. Agotados lee `menuItems`, resuelve la estación activa o la de respaldo con core, y llama `marcarAgotado`. Preparación llama `cambiarEstadoLineas`. Entrada y salida se validan con `CALLABLE_SCHEMAS` en `lib/cocina`. No se escribe directamente en Firestore, no se cambia core y no hay precios calculados por el cliente.

Los relojes cuentan desde marcha o listo. Solo vibra al cruzar el plazo de preparación con la pantalla visible y la vibración activada; no repite retrasos antiguos ni duplica el aviso de recogida de la tarea de sala. Una copia local se identifica y bloquea acciones. Una respuesta incierta bloquea cambios hasta una lectura confirmada del servidor. El plano existente se reutiliza para ubicar las mesas, sin inventar estados de sesión.

Pendiente al integrar el backend: repetir las capturas con pedidos reales y comprobar las escrituras de preparación y agotados contra sus reglas. El script actual espera expresamente el estado de servidor pendiente. Las pruebas unitarias sí cubren tickets, aislamiento, separación de destinos, agotados, listeners, avisos y respuestas inciertas con ejemplos de core identificados como tales. No se ha pedido ningún cambio en core.

Al terminar se envió SIGINT a ambas sesiones, que finalizaron con código 130. La comprobación posterior todavía encuentra los puertos de la fila 4 escuchando. El aislamiento de PID de cada ejecución impide localizar los procesos desde otra sesión con `fuser`; queda pendiente que el coordinador los detenga desde su terminal. No se intentó detener ningún servicio de otros agentes.

Commit propuesto: `Añade las pantallas de cocina y barra por estación y pases`. Cambios sin commit ni push.
