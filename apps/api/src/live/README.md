# Lecturas en vivo (SSE)

`POST /v1/live/<lectura>` con `Authorization: Bearer <ID token>` y cuerpo `{data: <entrada>}`. Responde
`text/event-stream`. **Nunca token en la URL**: el cliente usa `fetch` (no `EventSource`).
Cada módulo declara `liveQueries` en su `ModuleDefinition` (`roles`, `input`, `output`, `restaurantId`, `locationId` si hay local,
`topics`, `snapshot`, opcional `refreshMs`); `src/live/stream.ts` las resuelve de `MODULES`.

## Eventos

| Evento | Datos | Cuándo |
| --- | --- | --- |
| `snapshot` (`id: <n>`) | La foto validada con `output` | Al abrir y cada vez que llega un evento de sus temas |
| `ready` (`id: <n>`) | `{}` | Al reanudar con `Last-Event-ID` sin cambios relevantes |
| `error` | `{code, message}` y cierra | Sesión revocada (`unauthenticated`), miembro desactivado o sin permiso (`permission-denied`), plan vencido (`failed-precondition`) |
| `end` | `{reason}` y cierra | `renew` (a los 55 min, el token dura 1 h), `shutdown`, `slow` |
| `: ping` | — | Latido cada 15 s (nginx corta a los 30 s) |

## Cursor sin pérdidas

`events.id` se confirma fuera de orden entre transacciones concurrentes, así que leer por `id` puede saltarse
un evento. `005_live_events.sql` añade `events.tx` (`pg_current_xact_id()`) y solo se entregan eventos con
`tx < pg_snapshot_xmin(pg_current_snapshot())` (el horizonte), es decir, de transacciones ya cerradas. El `id`
de la trama SSE es `horizonte - 1`: en **cada vuelta el cursor avanza al horizonte**, haya o no eventos de sus
temas, así que la siguiente vuelta no reexamina lo ya visto. Se usa `EXISTS` con índices `(restaurant_id, tx)` y
`(restaurant_id, topic, tx)`; un `Last-Event-ID` inventado (muy viejo, futuro o no numérico) no recorre el
historial: parte del horizonte o equivale a abrir de nuevo.

### Una transacción abierta retrasa el horizonte

Cualquier transacción con escritura abierta frena la entrega de los eventos confirmados después de ella, para
todos los restaurantes. Defensas: el pool de la API fija `idle_in_transaction_session_timeout` (30 s) y
`transaction_timeout` (60 s, PostgreSQL 17+) al conectar (`createPool`); **el worker (V2) y cualquier otro
proceso con escritura deben fijar lo mismo en sus conexiones**. Además la API registra
`{event:'live_horizon_lag'}` (como mucho una vez por minuto) cuando hay eventos confirmados retenidos más de
`lagWarnMs` (10 s). `statement_timeout` no limita una transacción abierta e inactiva.

## Despertar y revocación

`LISTEN llenamos_events` (trigger `events_notify`, payload = solo el restaurante) adelanta la lectura, con un
retardo aleatorio de hasta `wakeJitterMs` (250 ms) para que un reinicio no despierte a todos a la vez. Con la
escucha sana el sondeo de respaldo es cada `backupPollMs` (20 s); si cae, cada `pollMs` (3 s). Cada vuelta abre
`withIdentity`: vuelve a comprobar sesión, rol, membresía, plan y local asignado, por lo que **revocar cierra el
flujo** en un ciclo de sondeo como máximo.

## Capacidad (la base no se queda sin conexiones)

- Cupos reservados **antes** de esperar nada (contador de pendientes): 12 conexiones por identidad, 80 por
  restaurante y 200 en total (`429 resource-exhausted`). El navegador limita a 6 por origen sin HTTP/2: varias
  pestañas comparten ese tope; multiplexar varias lecturas en un flujo queda como mejora futura.
- Un semáforo (`maxConcurrentDb`, 3) limita cuántas aperturas o vueltas usan la base a la vez; el resto del pool
  (10) queda para pedidos y cobros. Espera máxima 10 s y responde `503`.
- nginx: `limit_conn live_per_ip 24` en `/api/v1/live/` y `proxy_read_timeout 75s`.

## Caducidad del token

`IdentityToken.exp` limita la vida del flujo a `min(55 min, exp - ahora)`; un token caducado da `401`. El flujo
termina con `end {reason:'renew'}` y el cliente reconecta con un token nuevo.

## Local asignado

RLS solo filtra por restaurante. Toda lectura cuya entrada lleve un local **debe declarar `locationId(input)`**
en su `LiveQuery`: se comprueba contra `memberships.location_ids` al abrir y en cada vuelta (lista vacía = todos
los locales). Si cambia la asignación, el flujo se cierra con `permission-denied`. Las lecturas de caja ya lo
comprueban dentro de su `snapshot`.

## Errores y tamaño

Una foto de más de 1 MiB cierra con `error {code:'resource-exhausted', fatal:true}` y el cliente **no reintenta**.
Solo se corta a un cliente por lentitud (`slow`) si acumula más de 4 MiB sin leer. `server.close()` cierra todos
los flujos con `end`. `refreshMs` sirve para cambios que no pasan por eventos (plan y módulos desde plataforma).

## Escribir una lectura nueva

Emite `emitEvent(client, {restaurantId, topic: 'modulo.entidad', entityId})` dentro de la misma transacción
del cambio; declara esos temas (o `modulo.*`) en `topics`. La foto debe ser **acotada** (fecha/estado con
índice, límite): se vuelve a ejecutar con cada evento. Sin datos personales en el payload del evento.
