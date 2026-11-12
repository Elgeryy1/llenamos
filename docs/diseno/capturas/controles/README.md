# Controles propios de fecha y hora

19 capturas reales de Chromium a 2x, contra la web y Firebase locales del agente 2:
escritorio 1440 × 900, tableta táctil 1180 × 820 y móvil táctil 390 × 844.

- `fecha-nueva`: calendario propio del alta de un día especial.
- `dia-especial`: día especial con otro horario, sin guardar el borrador.
- `cierre-error`: un cierre que termina antes de empezar, con error y guardado bloqueado.
- `hora-fuera-turno` y `hora-elegida`: menú por cuartos de hora y elección de 03:15.
- `publica-calendario` y `publica-desplegable`: web pública, en escritorio y móvil.

`comprobaciones.json` recoge ocho recorridos y los errores de página (ninguno).
El guion comprueba el guardado real de un cierre, su persistencia tras recargar y su borrado;
el resto de cambios se descarta. Verifica que no aparecen controles nativos visibles, que
no hay desborde horizontal y que los calendarios y menús abiertos quedan dentro de la pantalla.
Los calendarios del panel y las opciones de hora miden al menos 44 × 44 px en táctil.
El calendario y las opciones públicas miden al menos 48 × 48 px. Se mide después de la
animación de apertura para comprobar el tamaño definitivo. Los calendarios disponen de
desplazamiento vertical dentro del menú cuando no caben junto al botón.

## Repetir

Desde la raíz de este worktree, con `pnpm install` y `pnpm funciones:build` hechos:

```sh
# Configuración local excluida de git, creada copiando firebase.json.
PUBLIC_APP_URL=http://localhost:3012 npx firebase emulators:start --project demo-llenamos --config firebase.agente2.json
# Otra terminal: apps/web/.env.local con los puertos de esta fila.
pnpm --filter web exec next dev --port 3012
# Preparar datos y ejecutar Playwright:
FIRESTORE_EMULATOR_HOST=127.0.0.1:8097 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103 pnpm seed
FIRESTORE_EMULATOR_HOST=127.0.0.1:8097 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103 pnpm seed:servicio
FIRESTORE_EMULATOR_HOST=127.0.0.1:8097 node docs/diseno/capturas/controles/preparar.cjs
node docs/diseno/capturas/controles/capturar.cjs
```

Puertos: Auth 9103, Firestore 8097, Functions 5013, Storage 9213, Hub 4412,
Logging 4512, Eventarc 9312, Tasks 9512 y web 3012. La UI queda desactivada: su puerto
4012 se reserva al websocket de Firestore para no abrir un puerto ajeno a la fila.
Los `NEXT_PUBLIC_*_EMULATOR_PORT` de `.env.local` usan los cuatro primeros puertos.

Si Playwright está fuera del proyecto, indica su `node_modules` en `NODE_PATH`.
`CHROMIUM_PATH` permite usar el Chromium ya instalado. Aquí se usaron
`/tmp/carta-tools/node_modules` y
`/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`.
Los lanzadores usan `XDG_DATA_HOME=/tmp/llenamos-cierre-data` y
`XDG_CONFIG_HOME=/tmp/llenamos-cierre-config` para no escribir configuración fuera del worktree.

## Decisiones y alcance

`DateInput` adapta el DatePicker existente al texto de fecha del formulario, conserva el año,
los límites mínimos, el borrado y los errores accesibles. La hora usa SelectField, mantiene
la hora actual aunque no coincida con un cuarto de hora y conserva la validación de servidor.
`touchSize={48}` conserva el tamaño público también en las opciones que Radix abre en un portal.
Muestra interactiva en `/panel/muestra#m-fechas`; API y licencia en `../../componentes.md`.

Cinco pruebas nuevas de Vitest cubren fecha vacía, límite mínimo, borrado, cambio de hora,
foco, selección de una hora por teclado, conservación de minutos y asociación de errores.
Sin dependencias nuevas. Sin cambios en funciones, reglas ni lógica de negocio.

Incidencia ajena detectada al preparar la revisión: el seed de fase 2 escribe `updatedBy: null`
en los documentos de carta y su proyección exige texto. Esto provoca errores de Zod y bloqueos
de transacciones en el emulador. `preparar.cjs` pone el uid de la propietaria en esos datos
locales y vacía los cierres de prueba. No modifica el seed ni el backend, que quedan fuera
de este encargo. El ajuste solo permite el emulador 127.0.0.1:8097.

Validación final: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` en verde.
759 pruebas pasan y las 42 pruebas de integración omitidas por el comando habitual siguen
omitidas. No se han tocado funciones ni reglas. Los puertos del agente 2 y el 5192 quedan
libres tras detener la web, la landing y los emuladores.
