# Z2 · Configuración

Capturas reales a **2x** de Taberna Lumbre contra `demo-llenamos`, con `pnpm seed` y `pnpm seed:servicio`. Web `http://localhost:3014` y emuladores de la fila 4: Auth 9105, Firestore 8099, Functions 5015, Storage 9215, UI 4014, Hub 4414, Logging 4514, Eventarc 9314 y Tasks 9514.

| Capturas | Ventana | Contenido |
|---|---|---|
| `plano-escritorio.png`, `horarios-escritorio.png`, `compartir-escritorio.png` | 1440×900 | Las tres pantallas |
| `plano-movil.png`, `horarios-movil.png`, `compartir-movil.png` | 390×844 táctil | Las tres pantallas sin desborde horizontal |
| `plano-tableta.png` | 1180×820 táctil | Plano e inspector de S1 a la vez |
| `plano-inspector-movil.png` | 390×844 táctil | Tamaño cambiado con el dedo y barra de guardado |
| `horarios-turnos-movil.png` | 390×844 táctil | Campos de los turnos con sus etiquetas |
| `horarios-capacidad-escritorio.png` | 1440×900 | Duraciones y límites |
| `compartir-cerrado-escritorio.png` | 1440×900 | Estado real al cerrar las reservas web |
| `compartir-widget-movil.png` | 390×844 táctil | Código incrustado |
| `muestra-configuracion.png` | 1440×900 | Las dos composiciones nuevas en el catálogo |

Para repetir, usa `firebase.agente4.json` y `apps/web/.env.local` con los puertos anteriores y `NEXT_PUBLIC_SITE_URL=http://localhost:3014`. Arranca desde este worktree:

```sh
npx firebase emulators:start --project demo-llenamos --config firebase.agente4.json
pnpm --filter web exec next dev --port 3014
```

Con ambos servicios listos, en otra terminal:

```sh
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8099
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9105
pnpm seed
pnpm seed:servicio
node docs/diseno/capturas/z2-config/capturar.cjs
```

El script usa `require('playwright')` y `chromium.launch()`, entra por los botones de demo de `/entrar` con la contraseña incorporada `Llenamos2026!` y comprueba propietario, encargado y camarero. Permite indicar `NODE_PATH` para Playwright y `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` para el Chromium instalado, sin añadir dependencias. En esta sesión se usó el Playwright del entorno y Chromium headless 1248 de la caché local.

El navegador fija solo su reloj visual al 9 de noviembre de 2026 a las 21:12 en Madrid y oculta el indicador de desarrollo de Next. Los datos y las escrituras son reales contra los emuladores. Si el entorno restringe las cachés, usa `XDG_DATA_HOME=/tmp/z2-config/data` y `XDG_CACHE_HOME=/tmp/z2-config/cache` para pnpm, y `XDG_CONFIG_HOME=/tmp/z2-config/config` para Firebase.

Comprobado: arrastre y tamaño con ratón y eventos táctiles reales, desplazamiento del plano desde el suelo, controles de al menos 44×44 px en las capturas móviles, teclado, descarte, altas de zona y mesa en borrador, guardado y recarga del plano, validación de turnos, copia de día, horario especial, guardado por encargado, cierre y apertura de reservas reflejados en Compartir, portapapeles del enlace y del iframe, apertura de la página pública y rechazo de las tres rutas al camarero. Los cambios guardados durante las pruebas se restauran al terminar.

Decisiones: reutilizar las sillas de `sala/Plano`; mantener toda la rejilla editable y desplazarla dentro de su caja en móvil; no cambiar acciones, permisos ni datos. `PageIntro` y `SettingsSection` viven en `common`, están documentados en `componentes.md` y tienen ejemplo en `/panel/muestra`.

Verificación final: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` en verde. Vitest: 753 pruebas superadas y 17 omitidas por la configuración de la suite de Functions. El recorrido completo de `capturar.cjs` termina con los tres roles comprobados y sin errores de página. No se han cambiado reglas, funciones, core ni lib.

Pendiente del entorno: al interrumpir las terminales se cerraron los procesos padres, pero los servicios hijos siguen escuchando. Cada terminal nueva tiene un espacio PID aislado y no puede verlos ni señalarlos. Desde una terminal del host, dentro de este worktree, `fuser -k -TERM 3014/tcp 4414/tcp` detiene la web de esta fila y el proceso principal de sus emuladores. Comprobar después que los puertos de la fila 4 han quedado libres. No se han señalado procesos de otras filas.
