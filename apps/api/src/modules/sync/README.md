# Sincronización sin conexión (servicio SQL)

Porta `functions/src/fase6-sync` a PostgreSQL. Es un servicio que **usarán sala y cocina**: este módulo
no conoce pedidos, líneas ni tareas; las operaciones concretas las aportan sus módulos (V4) con dos
registros. Mientras no estén registrados, el servicio responde `not-deployed` y **no guarda nada**.

## Operaciones (HTTP `POST /v1/operations/<nombre>`)

| Operación | Entrada / salida | Notas |
| --- | --- | --- |
| `sincronizarComando` | `{command}` → `{receipt}` (core) | Aplica o recupera. Idempotente por `commandId`. |
| `recuperarComando` | `{...SyncScope, commandId}` → `{receipt\|null}` | Antes de repetir un envío incierto. |
| `descartarComando` | `{command, requestId, reason}` → `{receipt}` | Solo el mismo uid que lo creó; deja `sync_resolutions` con autor. |
| `prepararSinConexion` | `{...SyncScope, entities[1..100]}` → `{versions, contentHashes, synchronizedAt}` | No está en core: es la proyección que ya usaba el cliente. |

Roles de la cola: owner, manager, waiter, kitchen, bar. Cada ejecutor declara además sus roles y su módulo.
Exige membresía activa, local asignado, módulo activo (`floor` por defecto), uid del comando = uid del token
y dispositivo no revocado (`sync_devices.active`).

## Garantías (probadas en `service.integration.test.ts`)

- Una respuesta perdida o dos pestañas ejecutan el efecto **una vez** y comparten recibo (la fila de
  `sync_streams` se bloquea con `FOR UPDATE`, así que dos tablets o pestañas se serializan).
- Mismo `commandId` con otro contenido (huella) → `409 already-exists`. Los recibos no caducan.
- Secuencia por dispositivo: `sequence = último saldado + 1`; si falta una anterior → `503 unavailable`.
  Un conflicto o rechazo **bloquea lo posterior** hasta descartarlo con motivo y autor.
- El efecto, el recibo, el cursor del flujo y el dispositivo se confirman en **la misma transacción**.
  El ejecutor corre en un `SAVEPOINT`: un `ApiError` de dominio (`failed-precondition`, `not-found` →
  conflicto `service_locked`; `permission-denied` → rechazo) revierte su efecto y se guarda el recibo.
  Cualquier otro error revierte todo, no consume la secuencia y se reintenta.
- Intenciones con más de 24 h o reloj del dispositivo adelantado más de 5 min → conflicto `expired`.
- Auditoría en `sync_activity` (sustituye a `activity` de Firestore): `sync.<operación>` al aplicar y `sync.discarded`
  con autor, nombre y motivo; un predecesor suprimido por privacidad se ignora al resolver precondiciones.
- Aislamiento por restaurante con RLS `FORCE` en las cuatro tablas (`005b_sync.sql`).
- `sync_receipts.privacy_redacted` lo usa la exportación/borrado de privacidad (V2): el recibo ya no se
  devuelve ni se reejecuta (`412 failed-precondition`).

## Lo que debe registrar quien posee las entidades (V4: sala y cocina)

```ts
import { registerSyncEntities, registerSyncExecutor } from '../sync/index.js'

registerSyncEntities({ read: async (client, scope, entities, actor) => /* EntityState|null por entidad */ })
registerSyncExecutor('enviarPedido', { module: 'floor', roles: [...], execute: async (client, command, actor) => /* salida de la operación */ })
```

- `read` devuelve, por entidad `{kind,id,version,hash}` (versión opaca emitida por servidor, hash del contenido
  normalizado) o `null` si no existe (el servicio la trata como `missing`). Es quien decide qué ve cada rol
  (cocina y barra solo sus líneas y platos): debe lanzar `ApiError(403,'permission-denied')`.
- `execute` debe ser **idempotente por `command.commandId`** (`enviarPedido` usa `requestId = commandId`) y
  validar su salida con los esquemas de `OFFLINE_OUTPUT_SCHEMAS`. Puede emitir eventos y encolar `outbox`
  con `emitEvent`/`enqueueOutbox` dentro de la misma transacción.
- Registrar una operación que ya tiene ejecutor lanza un error al arrancar.
- Todo escritor que cambie sesiones, líneas, tareas o carta debe seguir emitiendo la revisión opaca que `read`
  usa para construir la versión (misma regla que `syncRevision` en Firestore).

## Cliente

`apps/web/src/lib/sin-conexion/cliente.ts` (cola IndexedDB, Web Locks, recibos y reconciliación) ya usa estas
operaciones por la API cuando `NEXT_PUBLIC_DATA_BACKEND=postgres` (identidad por `auth-client.ts`, sin Functions).

## Quién lo usa

Sala y cocina (W2): `apps/api/src/modules/sala/sync.ts` registra los cinco ejecutores (`enviarPedido`, `marcharPase`,
`cambiarEstadoLineas`, `cambiarEstadoTarea`, `marcarAgotado`, por la misma ruta que la operación en línea) y el proveedor de
versiones (revisión de la fila, contenido y líneas enlazadas; cocina y barra solo ven las líneas y platos de su estación). La
huella de contenido coincide con la de las lecturas en vivo, así que la cola local conserva las versiones. Probado en
`sala.integration.test.ts`. Como el registro es único, `service.integration.test.ts` llama a `resetSyncRegistry()` antes de registrar los suyos.

## Pendiente fuera de este módulo

`OfflineCashNote` y la conciliación de efectivo (caja) llaman a `registrarCobro` por la API de caja.
