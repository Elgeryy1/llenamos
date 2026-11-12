# Cierre de cocina y barra

Agente 4, rama `fase2/completar-cocina`, 9 de noviembre de 2026. Se retoma el commit
`29e66ec` de trabajo en curso. Todo se ha ejecutado en este worktree, con Firebase
`demo-llenamos` y sin proveedores externos. No se ha hecho commit ni push.

## Resultado de las prioridades

| Prioridad e inventario | Resultado |
|---|---|
| 1 · O05, O06, K02 | Todas las líneas de estación llevan la nota general y una referencia corta común. Cocina y barra distinguen camarero, QR y web para llevar. La recogida enseña hora prometida, referencia y nombre completo. No se copian teléfonos, correos ni notas privadas. |
| 6 · Q05, K05, K06 y lección de pases | QR sale entero al aceptarlo, incluso si se solicita retener en la aprobación. Si no requiere aprobación, sale entero al pedir. La pantalla explica esa política. Los pases de camarero respetan la marcha elegida y muestran «Espera a sala». Una tarea de marcha conserva responsable y plazo al aprobar otro envío o pedir cuenta; no se puede completar ni anular mientras haya comida retenida. El filtro de espera incluye tickets con primeros en marcha y segundos retenidos. |
| 14 · K03, K12 | Selección de varias líneas para empezar o dejar listas, limitada a la estación. El servidor valida el lote completo antes de cambiar ninguna. Impresión del ticket mediante el diálogo del navegador, en fondo blanco y sin controles. |
| 9 · I01, I04 | Recuento total y por variante, con descuento atómico de todo el pedido, incluidos componentes de menú y pendientes de aprobación. Dos peticiones simultáneas de la última ración producen una venta y un rechazo. El total cero publica agotado. Se exige recuento del día del envío, según la zona del local; no hay reposición nocturna ni devolución automática al anular/rechazar. Vaciar un campo quita ese límite. |
| 3 · T08, N01 a N03 | Alta y baja de suscripción, consentimiento, VAPID por entorno, trabajador y enlace a la tarea. Solo tareas abiertas, vencidas y sin responsable; deduplicación por tarea, vencimiento y dispositivo, reintentos limitados y baja de endpoints caducados. Coger la tarea detiene los siguientes envíos y cierra notificaciones observadas por el panel. Sin claves se informa y no se permite activar. En emuladores solo captura. Pendiente la prueba real Android/iPhone bloqueado. |
| Tableta | Rejilla de tres columnas comprobada a 1180 px, platos de 24 px, notas de 20 px y controles de 48 px. Cocina y barra disponen del ancho de servicio de 1600 px. En móvil se convierte en una columna. |

Las pantallas de comandero, sala, carta pública, QR y recogida pública pertenecen a
los otros agentes y no se han editado. La corrección del estado público `held` se
hace en core; esas pantallas usan sus textos compartidos.

## Capturas reales a 2x

Chromium `chromium-1248`, Playwright, cuentas de demo de `/entrar`, contraseña
`Llenamos2026!`, `pnpm seed` y `pnpm seed:servicio`. Viewports de escritorio
1440 × 900, tableta 1180 × 820 y móvil 390 × 844. Las capturas de página completa
pueden ser más altas; todas mantienen `deviceScaleFactor: 2`. Los recortes de ticket
e impresión proceden del mismo contexto a 2x.

| Archivo | Evidencia |
|---|---|
| [cocina-tableta.png](cocina-tableta.png) | Tres tickets en paralelo con notas, origen y referencia; QR completo y segundos de camarero retenidos. |
| [cocina-escritorio.png](cocina-escritorio.png) | Rejilla en el ancho de escritorio. |
| [cocina-movil.png](cocina-movil.png) | Tickets en una columna. |
| [pases-en-espera.png](pases-en-espera.png) | El filtro conserva un ticket mixto con primeros en marcha y segundos esperando. |
| [seleccion-ticket.png](seleccion-ticket.png) | Dos líneas de cocina empezadas juntas. |
| [impresion-ticket.png](impresion-ticket.png) | Documento real que prepara el botón de impresión, claro y sin botones. |
| [ticket-recogida.png](ticket-recogida.png) | Hora prometida, referencia, nombre y nota de recogida. |
| [raciones-agotadas.png](raciones-agotadas.png) | Recuento cero después de competir por la última ración. |
| [barra-nota.png](barra-nota.png) | La misma nota general llega a la segunda estación. |
| [movil-tarea-retenida.png](movil-tarea-retenida.png) | Enlace directo a la tarea que sigue abierta al pedir cuenta. |
| [movil-avisos-sin-claves.png](movil-avisos-sin-claves.png) | Estado sin VAPID y tarea cogida. |
| [movil-avisos-captura-local.png](movil-avisos-captura-local.png) | Permiso concedido, trabajador registrado y explicación de captura local con claves de prueba. |
| [movil-aviso-silenciado.png](movil-aviso-silenciado.png) | Tarea reclamada y siguientes avisos silenciados. |

[recorrido.json](recorrido.json) y [avisos-local.json](avisos-local.json) guardan
los ids y las comprobaciones, sin secretos. El evento push del segundo recorrido
es sintético por CDP, sobre el trabajador real de Chromium. No es una entrega
de FCM, Firefox o Apple ni una prueba con pantalla bloqueada.

## Cómo repetir

Puertos exclusivos: Auth 9105, Firestore 8099, Functions 5015, Storage 9215,
Hub 4414, Logging 4514, Eventarc 9314, Tasks 9514 y web 3014. En la configuración
local excluida `firebase.agente4.json`, el websocket de Firestore ocupa 4014 y la
interfaz del emulador está desactivada para no abrir otro puerto. No se usan los
puertos del coordinador.

Con `firebase.agente4.json` y `apps/web/.env.local` configurados para esa fila:

```bash
pnpm install
pnpm funciones:build
npx firebase emulators:start --project demo-llenamos --config firebase.agente4.json
```

En otra terminal del mismo worktree:

```bash
export GCLOUD_PROJECT=demo-llenamos
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8099
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9105
pnpm seed
pnpm seed:servicio
pnpm --filter web exec next dev --port 3014
```

Sin variables VAPID en functions, ejecutar `node scripts/e2e-completar-cocina.cjs`.
El script crea cuatro mesas identificadas C1 a C4, pide por las callables reales,
verifica cocina/barra, lote, QR, cuenta con retenidos, raciones e impresión y
captura los resultados. Se puede repetir: limpia sus propios destinos de prueba.
Playwright usa el paquete local o el de `.claude/pw` indicado en el encargo.

### VAPID de prueba local

Primero se comprueba el caso sin claves. Después, con los emuladores parados:

```bash
node scripts/generar-vapid.mjs > functions/.env.local
npx firebase emulators:start --project demo-llenamos --config firebase.agente4.json
```

El generador usa exclusivamente `node:crypto` P-256. El archivo queda excluido de
git; no se publica ni se convierte la clave privada en `NEXT_PUBLIC_*`. Tras un
arranque vacío, repetir el seed antes de la prueba:

```bash
node scripts/e2e-avisos-local.cjs
```

Ese recorrido crea una suscripción criptográficamente válida de prueba, sin alta
en un proveedor; los emuladores la guardan y el procesador captura el aviso. Se
verifica que no avisa antes del vencimiento, dos procesadores generan una única
captura, el trabajador real muestra el evento sintético y «Voy yo» cierra la
notificación y silencia el procesador. El navegador bloquea peticiones fuera de
localhost y la suscripción de prueba queda desactivada al acabar.

Para procesar tareas manualmente con las mismas claves:

```bash
set -a
. functions/.env.local
set +a
GCLOUD_PROJECT=demo-llenamos FIRESTORE_EMULATOR_HOST=127.0.0.1:8099 pnpm exec tsx scripts/procesar-avisos.ts demo-lumbre centro
```

El planificador de Firebase no corre en emuladores; este script invoca el mismo
procesador. Se guardan estados `captured`, nunca `sent`. En un entorno compatible
sin emuladores, el botón registra la suscripción estándar del navegador. Cambiar
la clave pública renueva esa suscripción al volver a activar los avisos.

Si pnpm no puede preparar su instalación por el aislamiento de HOME, usar
`PNPM_HOME=/tmp/llenamos-pnpm XDG_DATA_HOME=/tmp/llenamos-xdg` delante del comando.

## Comprobaciones

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
TEST_FIREBASE_EMULATORS=1 GCLOUD_PROJECT=demo-llenamos FIRESTORE_EMULATOR_HOST=127.0.0.1:8099 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9105 pnpm --filter functions test
```

Parar los emuladores anteriores antes de ejecutar las reglas sobre los mismos puertos:

```bash
npx firebase emulators:exec --project demo-llenamos --config firebase.agente4.json --only firestore,storage "vitest run --root tests/rules"
```

Resultados: `lint`, `typecheck`, `test` y `build` en verde. Core: 338 pruebas;
web: 444; functions sin emuladores: 74. La ejecución de functions con emuladores
aprueba 124 y omite 11 de tres suites R2 que están fijadas al puerto 8097 de otro
agente; no se accede a esa fila. La suite específica de este cierre aprueba sus
17 casos después de las últimas correcciones. Reglas de Firestore y Storage: 78.
Los dos recorridos de Playwright también pasan. La activación del trabajador se
prueba desde `/panel`, además del enlace `/panel/avisos`, para cubrir el ámbito
`/panel/` sin que la promesa global `serviceWorker.ready` bloquee el inicio.

Las pruebas de funciones
incluyen raciones simultáneas, variantes, eliminación de límites, recuento caducado,
reposición diaria, componentes de menú, reserva pendiente, anulación/rechazo sin
reposición, aislamiento de estaciones y lotes, marcha QR, tarea con responsable al
aprobar y pedir cuenta, captura/deduplicación, reintentos y baja de suscripciones.
Las unitarias descifran el mensaje cifrado y verifican la firma VAPID con
`node:crypto`, sin red. Las reglas no cambian.

## Cada cambio de contrato

El detalle normativo está en «Cierre de cocina: tickets, marcha, raciones y avisos»
de [ARQUITECTURA.md](../../../../ARQUITECTURA.md):

1. `OrderLine.ticket?` y `StationTicket.ticket?`: instantánea común de referencia,
   origen, nota y datos operativos de recogida, con adaptación de `pickupAt` a Timestamp.
   Se completa historial anterior al reconciliar, sin ampliar acceso a contactos.
2. QR siempre marcha todo al aceptarse; nuevo estado público `held`, con textos
   compartidos para distinguir espera de preparación.
3. `FloorTask.purpose?: "fire_course"`: tarea de marcha por sesión viva con retenidos,
   conservando responsable y vencimiento. Solo se cierra al marchar o anular todo.
4. `MenuItem.portions?`: recuento diario opcional, total y por variante, consumo
   transaccional al pedir y política de recuento, caducidad y anulación explícita.
5. Callables nuevas `guardarRaciones`, `configuracionPush` y `guardarSuscripcionPush`,
   con esquemas de entrada/salida, permisos y módulos en core.
6. Colecciones privadas por local `pushSubscriptions` y `pushDeliveries`, sin acceso
   desde cliente, con titular, configuración VAPID y registro de deduplicación/reintento.
7. Procesador `avisosRetrasados` cada minuto y ejecución local compartida. Solo tareas
   vencidas sin dueño; revalida acceso y módulo, lease, tres intentos y baja HTTP 404/410.
8. Web Push aes128gcm y VAPID ES256 por variables de servidor; trabajador,
   consentimiento, enlace autenticado, renovación de clave, TTL de 60 segundos,
   manifiesto y captura forzosa en local. Un envío ya en tránsito puede llegar.

Acciones por lote usan la callable existente. La impresión del navegador es una
comanda operativa; la integración térmica y el ticket fiscal siguen en fase 3.

## Límites y entrega

Sin dependencias nuevas. Al terminar se han apagado la web y todos los emuladores
de la fila 4 y se ha comprobado que sus puertos quedan libres.
No se ha probado Android/iPhone físico con la pantalla
bloqueada, suscripción/entrega con un proveedor real, políticas de ahorro de batería,
impresora física ni térmica. La legibilidad física a dos metros debe comprobarse en
la tableta del piloto; aquí se aportan tamaño y capturas reales. La prioridad 3 queda
implementada y probada localmente, con esa validación de dispositivo pendiente antes
de prometer avisos de fondo en producción.

Mensaje de commit propuesto: `Completar cocina: tickets, pases, raciones y avisos de retraso`.
