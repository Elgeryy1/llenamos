# Operaciones de módulos: transporte preparado, backend pendiente

`invokeOperation` envía las operaciones de los wrappers siguientes a
`POST /api/v1/operations/:name` cuando `NEXT_PUBLIC_DATA_BACKEND=postgres`.
Cada wrapper conserva los esquemas de entrada/salida de `@llenamos/core` y sus
mensajes de confirmación incierta. No se generan respuestas de éxito locales.

| Módulo | Wrapper | Operaciones enviadas con su nombre de contrato |
| --- | --- | --- |
| Reservas | `data/reservas.ts`, `data/clientes.ts`, `data/hooks.ts`, `plano/guardar.ts`, `publica/*` | Implementadas en la API (módulo `reservas`): públicas, personal, `guardarPlano`, `editarCliente`, `verRestaurantePublico`. Lecturas con `useLiveQuery` (V1). Requiere `API_INTERNAL_ORIGIN` en el servidor de Next |
| Caja | `caja/api.ts` | Todas las de `CALLABLES_FASE3`, como `abrirCaja`, `verCuenta`, `devolverCobro` |
| Análisis | `analisis/api.ts` | `CALLABLES_FASE5_ANALISIS`, como `panelAnalisis`, `verResumenDiario` |
| Compras | `compras/api.ts` | `guardarProveedor`, `guardarFormatoProveedor`, `guardarPedidoProveedor`, `cambiarEstadoPedidoProveedor`, `recibirPedidoProveedor`, `sugerirPedidos` |
| Campañas | `campanas/api.ts` | `CALLABLES_FASE5_MARKETING`, incluida la baja pública `darseDeBaja` |
| Fidelización | `fidelizacion/api.ts` | `CALLABLES_FASE5_FIDELIZACION`, incluidos premios, puntos, promociones y Repite |
| Personal | `personal/api.ts` | `CALLABLES_FASE4_PERSONAL`, incluidos `fichar` y las operaciones de turnos/PIN |
| Sala/comandero | `comandero/callables.ts` | Operaciones de su contrato core, incluidas `abrirMesa`, `enviarPedido` y tareas |
| Cocina | `cocina/callables.ts` | `cambiarEstadoLineas`, `marcarAgotado`, `guardarRaciones` |
| Carta y QR público | `carta/callables.ts` | Categorías, platos, menús, configuración, QR y los seis endpoints públicos de mesa/recogida de `FASE2_ACCESS` |
| Inventario | `inventario/acciones.ts` | Ya usa `llamarCore`; ahora clasifica también errores VPS al conservar o cerrar una intención |

Este cambio **no implementa los handlers SQL de estos módulos**. Cada operación
requiere estar registrada y probada en la API. Una operación sin handler devuelve
404 (`not-deployed`); una entidad inexistente de un handler sí implementado usa
`not-found`. Ninguno de esos fallos activa Firebase como alternativa.

Las llamadas privadas llevan el ID token Firebase solo en `Authorization`.
`darseDeBaja` y los seis endpoints públicos de mesa/recogida no solicitan identidad,
aunque el navegador tenga una sesión o el caller pase el antiguo indicador de Auth.
En carta la política sale de `FASE2_ACCESS`, no de la elección del caller.

La demo conserva los emuladores únicamente con proyecto `demo-*` y selector
`firebase-demo` o ausente. El SDK de Functions se importa al ejecutar una llamada
privada de demo; los wrappers no inicializan datos de Firebase en modo VPS.

Sala y cocina conservan `queueOperation` exclusivamente en demo. En VPS envían
operaciones online a la API y **no encolan cambios locales**: falta portar el
protocolo de sincronización y recuperación a SQL. Las lecturas Firestore,
suscripciones y escrituras directas de cada módulo siguen pendientes. Estos
wrappers preparados no hacen que el módulo completo funcione en producción.

## Lecturas en vivo de personal, inventario y compras (V6)

`lib/personal/datos.ts`, `lib/inventario/datos.ts` y `lib/compras/datos.ts` conservan sus ganchos. Con
`NEXT_PUBLIC_DATA_BACKEND=postgres` cada uno llama a `useLiveQuery(nombre, entrada, esquema)` de `lib/api/live.ts`
(nombres y esquemas en `PERSONAL_LIVE` e `INVENTARIO_LIVE` de `@llenamos/core`) y deja la escucha de Firestore con clave
nula. `useInformeHoras`, `useHorasParaPropinas` y `useMargenes` ya iban por operaciones. Hasta que V1 implemente
`useLiveQuery`, estas lecturas devuelven el error `not-deployed` y las pantallas lo enseñan.

## Sala, carta y cocina (V4, completado por W2)

Las 34 operaciones de `CALLABLES_FASE2` y `verCartaPublica` tienen handler SQL en `apps/api/src/modules/sala`. Las lecturas
(`lib/comandero/datos.ts`, `lib/carta/hooks.ts`, `lib/cocina/datos.ts`, avisos) usan `lib/sala/vivo.ts` con
`NEXT_PUBLIC_DATA_BACKEND=postgres` (`salaServicio`, `salaHistorial`, `salaCarta`, `cocinaLineas` sobre `useLiveQuery`; las mesas y
recogidas cerradas llegan de las últimas 18 h).

- **Fotos de la carta:** `lib/carta/photos.ts` sube con `uploadFile(..., "carta_foto")` (servicio de archivos, sesión en cabecera) y
  guarda en el plato `restaurants/{rid}/locations/{lid}/menu/{plato}/{idArchivo}`, que cumple el contrato y la comprobación de
  `guardarPlato`. Se ven por `/api/v1/public/files/{rid}/{id}` (sin sesión, también en la carta del cliente).
- **Sentar una reserva desde sala:** `GestionMesa` lee las reservas del día con `useDayReservations` y `useReservationSettings`
  (API en VPS) y `abrirMesa` con `reservationId` pasa por la ruta de reservas (V11).
- **Cola sin conexión:** `llamarSala` y `llamarCocina` encolan `enviarPedido`, `marcharPase`, `cambiarEstadoLineas`,
  `cambiarEstadoTarea` y `marcarAgotado` también en VPS (`sincronizarComando`); `guardarRaciones` y el resto van directos y exigen
  conexión. Ejecutores y versiones en `apps/api/src/modules/sala/sync.ts`.
- **Avisos al móvil:** se ofrecen en VPS; el worker envía las tareas vencidas sin dueño (`sala.avisos_push`, migración 019) y
  `AvisosMovil` retira del dispositivo los avisos de tareas cogidas o cerradas con el servicio en vivo.
- **Demo:** las lecturas con Firestore viven en `lib/sala/demo.ts` y `lib/cocina/datos-demo.ts` y se cargan con `import()`
  dinámico dentro del efecto; `lib/sala/sin-firestore.test.ts` falla si el terreno de sala vuelve a importarlos de forma estática.

## Reservas, plano, equipo y proveedores en VPS (W1)

Sin Firestore, Functions ni Storage en el bundle de producción: la demo carga su código con `import()` dentro de su rama.
- `lib/data/demo-live.ts` (ganchos `useDemoDoc`, `useDemoDocs`, `useDemoQuery`) sustituye a `useLiveDoc`/`useLiveQuery` en la rama demo;
  `demo-firestore.ts` es lo único que importa el SDK y solo se pide con `import("./demo-firestore")`. Las consultas se describen con datos
  (`{ path, where, orderBy, limit }`). Otros módulos pueden usarlo para sacar su rama demo del bundle.
- `components/panel/PanelData.tsx` solo trae la lectura del VPS; el panel de la demo está en `PanelDataDemo.tsx` (`next/dynamic`).
- Lecturas VPS: `plano`, `reservasDia`, `ajustesReservas`, `listaEsperaDia`, `clientes`, `cliente`, `reservasCliente`, `miembros`,
  `mensajesRecientes` y `mensajesReserva` (módulos `reservas` y `proveedores`). La ficha pública sale de `verRestaurantePublico`.
- Escrituras por operación: `guardarPlano` (los ids de zonas y mesas los crea el navegador, también en la demo), `editarCliente`, `guardarConfiguracionReservas`.
- `useActivity` responde `not-deployed` en VPS: no hay registro general de actividad en SQL.
- Claves de proveedores del restaurante: `verProveedoresRestaurante` y `guardarProveedoresRestaurante` (solo propietario), en Ajustes
  (`components/proveedores/ProveedoresRestaurante.tsx`). Detalle en `apps/api/src/modules/proveedores/README.md`.
- `lib/data/demo-carga.ts` es la puerta a la demo: el literal `process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres" ? … : import(…)` lo sustituye el empaquetador y la rama
  se descarta (también en `PanelData.tsx`). Comprobado con `next build` y `postgres`: `demo-firestore`, `demo-escrituras` y `PanelDataDemo` no salen en la compilación. El SDK
  de Firestore sigue en ella por terrenos de otros agentes (carta, comandero, fidelización, etc.).
- `src/lib/data/sin-firestore.test.ts` recorre el cierre de imports estáticos (compilador de TypeScript) de los archivos de reservas y falla si llegan a Firestore, Functions o Storage.
- La actividad general no existe en SQL: en VPS se oculta del menú (`navForRole`) y de Inicio, y `/panel/actividad` dice que no hay registro común.
- Pendiente de W4: `CustomerSheet` arrastra Firestore por `lib/fidelizacion/datos.ts`; las pantallas de clientes y reservas lo cargan hasta que W4 lo saque.

## Caja, cobro móvil e impresión (W3)

Las operaciones de `CALLABLES_FASE3` tienen handler SQL en `apps/api/src/modules/caja`, incluidas las del cobro móvil con la Stripe
del restaurante (`crearEnlaceCobro`, `verCobroPublico`, `iniciarPagoCuenta`, `crearReciboDigital`, `verReciboDigital`) y las dos
del QR de mesa (`verPartesPagoMesa`, `elegirPartePagoMesa`). La señal de reserva (`iniciarPagoSenal`) crea su sesión de Checkout
con la misma clave del restaurante. Lecturas (`lib/caja/datos.ts`, `lib/impresion/datos.ts`): `caja*` por `useLiveQuery`; mesas y
recogidas abiertas de `salaServicio`; estaciones de `salaCarta`. Firestore solo se carga con `import()` dentro de
`lib/caja/datos-demo.ts` en la rama demo. Las páginas públicas `/p/...` y `/recibo/...` llaman a la API sin identidad
(`lib/pago-movil/api.ts`). Pendientes: reembolso real con Stripe y proveedor fiscal (el cobro queda confirmado y la factura sin
emitir). La cola sin conexión de caja no existe: caja exige conexión por diseño.

## Gestión en VPS: personal, inventario, compras, análisis, campañas y fidelización (W4)

Todas las lecturas de estos seis módulos salen de la API con `NEXT_PUBLIC_DATA_BACKEND=postgres` (`useLiveQuery` de
`lib/api/live.ts`; análisis, campañas y fidelización con `analisis.*`, `campanas.*` y `fidelizacion.*`) y las escrituras
por `invokeOperation`. La escucha de Firestore de la demo vive en `lib/fase4/demo.ts`, que carga `firebase/firestore` con
`import()` dentro del efecto y solo con clave no nula: en el paquete de producción no hay Firestore, Functions ni Storage
en estas carpetas. `lib/fase4/sin-firebase.test.ts` falla si alguien vuelve a importarlos de forma estática, y
`apps/api/src/modules/gestion-web.test.ts` falla si la web pide una lectura que la API no registra.

Registro de jornada (DECISIONES.md, 2026-11-12): `exportarMisFichajes` (propio, o el de otra persona si lo pide un
encargado) y descarga en `components/personal/ExportarRegistro.tsx` (solo en VPS). Los fichajes no se borran y a los 4 años
se anonimizan (`personal.anonimizar_fichajes`, migración 021, con la base impidiendo borrar o anonimizar antes de tiempo).
