# Carta y pedido público

Capturas reales del agente 5, a 2x, con Next en `http://localhost:3015`, proyecto `demo-llenamos`, `pnpm seed` y `pnpm seed:servicio`. Acceso por `/entrar` con `propietario@lumbre.test` y contraseña `Llenamos2026!`. Escritorio 1440×900, tableta 1180×820 y móvil 390×844. El script comprueba ausencia de errores de página y desbordamientos horizontales.

El backend de fase 2 aún no existe en esta rama. Las capturas enseñan los errores reales de las callables y reglas pendientes. No se intercepta la red, no se publican fixtures ni se simula un pedido confirmado. El token de los enlaces de prueba solo sirve para alcanzar el error de función ausente. `editor-plato-borrador.png` muestra texto escrito en un formulario sin guardar.

| Captura | Contenido |
|---|---|
| `carta-escritorio.png`, `carta-movil.png` | Carta privada, con aviso de lecturas aún no permitidas |
| `editor-servidor-pendiente.png` | Guardar una categoría llama a `guardarCategoriaCarta` y muestra que falta el servidor |
| `editor-plato-borrador.png` | Editor de plato y traducciones, sin guardar |
| `configuracion-escritorio.png` | Ajustes iniciales, indicados como sin confirmar |
| `qr-tableta.png` | Plano reutilizado y selección de mesas para QR y NFC |
| `mesa-movil.png` | `verMesaPublica` ausente |
| `carta-publica-movil.png` | Proyección pública todavía no accesible |
| `para-llevar-movil.png`, `para-llevar-tableta-ca.png` | Consultar recogida, castellano y catalán |
| `seguimiento-movil.png`, `seguimiento-movil-en.png` | Seguimiento, castellano e inglés, sin servidor |

Para reproducir: copiar `.env.example` a `.env.local` con Auth 9106, Firestore 8100, Functions 5016 y Storage 9216; crear `firebase.agente5.json` desde `firebase.json` con UI 4015, Hub 4415, Logging 4515, Eventarc 9315 y Tasks 9515. Arrancar:

```sh
npx firebase emulators:start --project demo-llenamos --config firebase.agente5.json
FIRESTORE_EMULATOR_HOST=127.0.0.1:8100 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9106 pnpm seed
FIRESTORE_EMULATOR_HOST=127.0.0.1:8100 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9106 pnpm seed:servicio
pnpm --filter web exec next dev --port 3015
PLAYWRIGHT_DIR=/tmp/carta-tools node docs/diseno/capturas/carta-publica/capturar.cjs
```

`PLAYWRIGHT_DIR` señala la carpeta que contiene Playwright, herramienta del entorno que no se añade a las dependencias del proyecto. `CHROMIUM_PATH` permite elegir el ejecutable. En esta caja se usaron `PNPM_HOME=/tmp/llenamos-pnpm`, `XDG_CACHE_HOME=/tmp/llenamos-cache` y, para Firebase, `XDG_CONFIG_HOME=/tmp/llenamos-firebase-config` y `TMPDIR=/tmp/llenamos-agent5`, para no escribir en directorios de configuración ajenos al worktree.

Comprobaciones: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Las 38 pruebas nuevas cubren céntimos, validación de fotos, esquemas de entrada/salida, errores de servidor, QR contrastados con matrices independientes, variantes, agotados, precios cambiados, horarios de menús, cambio de sesión y envío único. Los recorridos de mesa hasta servido y de para llevar hasta recogido se prueban con fixtures de core y respuestas unitarias identificadas como ejemplos. El recorrido real completo, Storage y publicación de carta quedan para la integración del backend.

Datos para que el coordinador integre la navegación, sin modificarla aquí:

```json
[
  { "href": "/panel/carta", "label": "Carta", "permission": "carta.editar", "module": "floor" },
  { "href": "/panel/configuracion-sala", "label": "Configuración de sala", "permission": "sala.configurar", "module": "floor" }
]
```

Estaciones requiere también `kitchen`. Las rutas públicas son `/r/[slug]/carta?local=...`, `/r/[slug]/para-llevar?local=...`, `/r/[slug]/para-llevar/[reference]?t=...` y `/m/[slug]/[locationId]/[tableId]?t=...`. Se usa el cliente de Firebase y la sesión existentes. Un puente HTTP limitado a las callables propias, bajo `/m/api/[name]`, permite detectar los 404 sin CORS del emulador; no implementa reglas de negocio ni sustituye a Functions.

Decisiones: los precios se revisan con core y el servidor conserva la autoridad; los rechazos obligan a revisar de nuevo. Un envío con respuesta incierta deja un marcador por pestaña y bloquea su reenvío incluso después de recargar. En mesa se consulta el estado y se pide comprobarlo con el personal antes de vaciar el borrador. Para llevar, si se pierde la respuesta inicial no se dispone del token de seguimiento y se pide hablar con el personal. Las fotos usan `getBlob` autorizado por reglas, sin enlaces permanentes de descarga. El QR se genera localmente en SVG y el mismo enlace se copia para la etiqueta NFC.

Sin dependencias nuevas del producto, sin cambios en core, funciones, reglas ni navegación y sin commit ni push. Mensaje propuesto: `Añade la gestión de carta y el pedido público desde mesa y para llevar`.

Al cerrar, las sesiones de herramientas terminaron pero quedaron procesos escuchando. Firestore se apagó mediante su endpoint local. Quedan activos Auth 9106, Functions 5016, Storage 9216, UI 4015, Hub 4415, Logging 4515, Eventarc 9315, Tasks 9515 y web 3015. El espacio de procesos aislado de cada llamada no permite señalarlos desde una nueva sesión; el coordinador debe detener esos puertos desde su terminal del host. No se han señalado procesos ajenos.
