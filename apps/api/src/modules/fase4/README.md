# Personal, inventario, costes y compras en PostgreSQL (V6)

Portado de `functions/src/fase4`. Dos módulos registrados en `modules/index.ts` (`personal` e `inventario`,
este último incluye costes y compras) y código común en `modules/fase4`. Migración `010_personal_inventario.sql`.
Pruebas: `personal/personal.integration.test.ts` e `inventario/inventario.integration.test.ts`
(`TEST_POSTGRES_API=1`, con `sh scripts/test-postgres-docker.sh`).

## Qué hay

- **31 operaciones** con los nombres, entradas y salidas de `CALLABLES_FASE4` (core). Permiso y módulos salen de
  `FASE4_ACCESS`; el servidor filtra por rol y `openCtx` comprueba miembro activo, local y módulo.
- **Datos**: cada documento conserva su contrato de core en `doc` (jsonb) con columnas generadas para filtrar con índice.
  RLS `FORCE` por restaurante, dueño `llenamos_migrator`, GRANT mínimos. Los libros (`inv_stock_movements`,
  `inv_goods_receipts`, `inv_recipe_versions`, `staff_time_entry_events`) son solo INSERT para el rol de ejecución.
- **Concurrencia**: cerrojo consultivo por restaurante (personal, porque un fichaje abierto vale para todos los locales)
  o por local (inventario) que sustituye a las transacciones de Firestore. La unicidad la refuerzan índices
  (una receta por plato y variante, un formato preferido por ingrediente, referencia de pedido, un fichaje abierto por persona).
- **Idempotencia**: `llenamos.idempotency` por local, actor, operación y `requestId`. Repetir con la misma entrada
  devuelve el resultado original; con otra entrada, `already-exists`.
- **Eventos** (sin datos personales, uno por tema y transacción): `personal.fichaje`, `personal.turno`, `personal.ajustes`,
  `personal.puesto`, `inventario.stock`, `inventario.receta`, `inventario.recuento`, `inventario.ajustes`,
  `compras.proveedor`, `compras.pedido`. Actividad (auditoría) en `fase4_activity`.
- **Lecturas en vivo** (`liveQueries`, contratos en `@llenamos/core`: `PERSONAL_LIVE` e `INVENTARIO_LIVE`):
  `personalFichajes` (≤93 días), `personalFichajesAbiertos`, `personalTurnos`, `personalEventosFichaje`, `personalAjustes`,
  `inventarioStock`, `inventarioAjustes`, `inventarioCostes`, `inventarioRecetas`, `inventarioVersiones`,
  `inventarioRecuentos`, `inventarioMovimientos`, `inventarioPlatos`, `comprasProveedores`, `comprasIngredientes`,
  `comprasPedidos`, `comprasAlbaranes`. Todas con límite, fecha, estado o id; costes solo con `costes.ver`.
- **Lecturas completas**: lo que debe ser entero (existencias, costes, recetas, proveedores, carta, fichajes de un periodo,
  turnos vecinos…) pide límite+1 y **falla** con `failed-precondition` en vez de recortar en silencio (`listAll`). Solo son
  «los últimos N» a propósito: pedidos (200), albaranes, recuentos (30), versiones (20) y movimientos (`max`).
- **PIN**: scrypt con sal propia por persona; el bloqueo crece 5, 10, 20 min… hasta 24 h por cada tanda de 5 fallos y se
  reinicia al acertar. `ficharEnPuesto` y `guardarPinFichaje` no se guardan en `idempotency` (la huella de la entrada
  permitiría recuperar el PIN); `ficharEnPuesto` repetido tras perder la respuesta puede devolver «ya tienes el fichaje abierto».
- **Informes acotados**: `informeHoras` ≤366 días y 20 000 fichajes; `margenPlatos` ≤93 días y 50 000 líneas, por páginas.

## Descuento de stock por venta: la entrada

No es una operación (como en el origen). Lo hace `consumeLine(client, scope, lineId, now?)` de
`modules/inventario/consumo.ts`, exportada también desde `modules/inventario/index.ts`.

- **Quién la llama: sala (V4), ya conectada.** `modules/sala/hooks.ts` expone `registerLineStateHook`; `context.flush()` de sala
  lo ejecuta con las líneas de pedido nuevas o con otro estado (enviar, marchar, preparar, servir, anular, devolver…), ya
  escritas y **en la misma transacción** que las guarda. Inventario lo registra en `inventario/index.ts`: cada línea va en un
  `SAVEPOINT`, de modo que un fallo de inventario no bloquea el pedido (queda registrado sin datos personales y se programa la
  reconciliación). Sirve igual para el personal (sesión de miembro) que para los pedidos públicos por QR y recogida web: sala
  pasa lo que ya cargó del restaurante y 010 añade políticas `sala_public*` estrechas sobre las tablas de inventario que
  hacen falta. **Caja (V5) no descuenta stock**, así que no hay doble descuento.
- `consumeLine` **no recibe la línea**: con el cerrojo del local tomado la relee con `lineSource().line()` (`FOR SHARE`,
  necesita privilegio UPDATE sobre `sala_order_lines`, que sala ya tiene). Así dos avisos desordenados (una anulación y luego
  un `fired` antiguo) no descuentan ni devuelven dos veces. Es idempotente: ids de movimiento deterministas y estado en
  `inv_line_costs`.
- Sin módulo `inventory` o con `consumeOnSale` desactivado devuelve `inactive`. Sin receta, `no_recipe` y no se reevalúa.
- Si sala no quiere que un fallo de inventario bloquee un pedido, que la llame en un `SAVEPOINT`; la reconciliación recoge
  lo que falte.

## Procesos periódicos (worker de V2)

Declarados en `ModuleDefinition.workerHandlers` (tipo `WorkerHandler` de `worker/types.ts`, V2):

| Trabajo | Módulo | Cada | Qué hace |
| --- | --- | --- | --- |
| `personal.revisar_fichajes` | personal | 15 min mientras haya fichajes abiertos | marca los fichajes olvidados y lo deja en la actividad |
| `inventario.reconciliar` | inventario | 60 min mientras haya ventas | repasa las líneas de las últimas 48 h y corrige el consumo |

Nadie tiene que sembrarlos: el primer fichaje de entrada del local y cada consumo de una línea encolan el siguiente pase con
`enqueueJob` de V2 (clave `local:ranura`, id estable, sin duplicados: **un trabajo pendiente por local activo**), y cada pase se
reprograma solo si queda algo que vigilar (`scheduleLocalJob`, en `fase4/trabajos.ts`). Si una cadena se pierde (trabajo en
cuarentena), la siguiente actividad del local la vuelve a sembrar. Los manejadores usan `context.tenant()`: transacción del restaurante **sin
identidad de miembro**; el acceso lo da `can_access_restaurant` al rol `llenamos_worker` (006 de V2) y
`llenamos.fase4_local_members` lo reconoce con `session_user`. Las pruebas ejecutan el worker real de V2 (`createWorker` con
`buildHandlers(MODULES)`).

## Puertos hacia otros módulos (`fase4/puertos.ts`)

Leen las **tablas reales** de V4 y V5 (`sala_menu_items`, `sala_order_lines` de 008 y `pos_cash_sessions` de 009), con su RLS y
dentro de la transacción de quien llama; lo que no existe en el local da «no existe», nunca datos inventados. Se pueden
sustituir con `registerMenuCatalog`, `registerLineSource` y `registerCashWindowSource`.

- `MenuCatalog`: `guardarReceta` (valida plato, variante y extras), `margenPlatos` e `inventarioPlatos`.
- `CashWindowSource`: `horasParaPropinas` (ventana de la caja).
- `LineSource`: `consumeLine` (lectura `FOR SHARE`, necesita UPDATE sobre `sala_order_lines`, que sala tiene) y
  `reconcileConsumption`, apoyada en el índice `sala_lines_placed` de 010.

## Qué no está

- El seed de demostración (`functions/src/fase4/seed.ts`) no se porta: es solo de los emuladores.
- El detalle del error de PIN (`attemptsLeft`, `lockedUntil`) viaja en el mensaje; el contrato HTTP común no transporta `details`.
- `ficharEnPuesto` con PIN erróneo confirma el intento y entrega el 403 tras el COMMIT (`afterCommit`), porque el servidor
  deshace la transacción cuando el handler lanza.

## Privacidad de los fichajes (W4, migración 021)

Decisión del propietario, 2026-11-12: el registro de jornada se puede **exportar** a petición del trabajador, **no se borra**
mientras dure la obligación legal (4 años, art. 34.9 del Estatuto de los Trabajadores) y pasado el plazo se **anonimiza**.

- `exportarMisFichajes` (`personal/retencion.ts`): `uid` null es el propio (`fichaje.registrar`); el de otra persona exige
  `personal.gestionar` y deja `staff.export_entries` en la actividad (cada exportación deja su rastro, también un reintento).
  Entrega fichajes y eventos del local, estos por `entry_id`; si no caben (6 000 fichajes, 24 000 eventos) falla en vez de recortar.
- Anonimización: trabajo `personal.anonimizar_fichajes` por local, diario, que siembran `fichar` (entrada) y `crearFichajeManual` y que
  se reprograma mientras queden fichajes atribuidos. **No depende del módulo ni de la suscripción** (contexto de sistema sin esas
  comprobaciones y sin el cerrojo del restaurante). Cada pase parte del índice de lo pendiente, saca un lote de fichajes (también
  abiertos) y anonimiza a la vez sus eventos y ellos: `uid` y `by` a `anonimizado`, sin nota, motivo ni `shiftId`. Anonimiza también
  los turnos de más de 4 años y limpia la actividad `staff.*`. Conserva fecha, horas y minutos y avisa con `personal.fichaje`.
- La base lo hace cumplir (`021_fichajes_retencion.sql`): sin DELETE para el rol de ejecución; los eventos, los fichajes, los turnos
  y la actividad solo admiten pasar a `anonimizado` y solo pasado el plazo; no se vuelve a atribuir. El resto de la actividad es de solo añadir.
- No se enlaza con las solicitudes de privacidad de clientes (`modules/privacidad`): esas son de clientes, no de personal.
