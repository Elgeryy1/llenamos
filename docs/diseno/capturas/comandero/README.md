# Comandero y sala

Capturas reales a 2x del 9 de noviembre de 2026, con `demo-llenamos`, `pnpm seed` y `pnpm seed:servicio`. Escritorio 1440×900, tableta 1180×820 y móvil 390×844. Acceso por `/entrar`: propietario en escritorio y tableta, camarero en móvil, contraseña `Llenamos2026!`.

Cada tamaño tiene cuatro imágenes: `comandero`, `sala`, `para-llevar` y `falta-servidor`. La última intenta abrir S1 con la callable real. En esta rama faltan el backend y las reglas de fase 2: las imágenes enseñan los errores de lectura y la falta de servidor, nunca pedidos ficticios. El plano y las reservas sí proceden de los emuladores. Playwright comprueba las tres rutas, la ausencia de desbordamiento horizontal y de errores de React.

## Repetir

Desde este worktree, copia `.env.example` a `apps/web/.env.local`, con puertos Auth 9102, Firestore 8096, Functions 5012 y Storage 9212. Usa la configuración local excluida `firebase.agente1.json` y la web 3011:

```bash
XDG_CONFIG_HOME=/tmp/comandero-config npx firebase emulators:start --project demo-llenamos --config firebase.agente1.json
FIRESTORE_EMULATOR_HOST=127.0.0.1:8096 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9102 pnpm seed
FIRESTORE_EMULATOR_HOST=127.0.0.1:8096 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9102 pnpm seed:servicio
pnpm --filter web exec next dev --port 3011
node docs/diseno/capturas/comandero/capturar.cjs
```

El script admite `PLAYWRIGHT_MODULE` y `CHROMIUM_PATH` si Playwright y Chromium están instalados fuera del worktree. Usa `localhost:3011`, permitido por el servidor de desarrollo de Next. No intercepta peticiones. Los datos de ejemplo de core se usan solo en Vitest.

La configuración preparada desactiva la UI de emuladores y reserva 4011 para `firestore.websocketPort`, porque Firebase añade ese puerto auxiliar y la tabla no le asigna uno. Hub 4411, logging configurado 4511, Eventarc 9311 y Tasks 9511. El primer arranque asignó automáticamente WebSocket 9153; las capturas se hicieron contra ese arranque. No se usaron los puertos prohibidos ni servicios de nube. `XDG_CONFIG_HOME` evita que Firebase intente escribir credenciales en un directorio de solo lectura.

Limpieza pendiente del entorno: las señales de parada cerraron los lanzadores con salida 130, pero `ss` todavía muestra la web 3011 y los emuladores en 9102, 8096, 5012, 9212, 4011, 4411, 4511, 9311, 9511 y el WebSocket 9153. El sandbox de cada comando no expone sus PID y `fuser` no los encuentra para detenerlos. Hay que parar esos procesos propios desde la sesión anfitriona antes de volver a arrancar con la configuración preparada. No se han detenido procesos ajenos.

## Integración del coordinador

Entradas de menú como datos, sin modificar navegación común:

```json
[
  { "href": "/panel/comandero", "label": "Comandero", "permission": "comandas.tomar", "module": "floor" },
  { "href": "/panel/para-llevar", "label": "Para llevar", "permission": "comandas.tomar", "module": "floor" }
]
```

Sala conserva su entrada actual y su funcionamiento sin `floor`. Las tres pantallas usan el Firebase y la sesión existentes, y callables validadas desde `lib/comandero`. No hay escrituras directas de cliente. No se cambiaron core, backend, reglas ni dependencias del proyecto. El backend pendiente debe aportar carta, configuración, sesiones, pedidos, tareas y recogidas. El recorrido completo reserva → pedido → cocina → servido → cierre queda para la integración.

Comprobaciones: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Las pruebas nuevas cubren variantes, menú sin duplicar el precio del plato, validación de callables, contención de «Voy yo», conservación del borrador ante fallo y sesión movida o absorbida mientras se pide.

Commit propuesto: `Añade comandero, gestión de sala y recogidas para llevar`.
