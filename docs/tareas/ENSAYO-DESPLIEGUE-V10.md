# Ensayo de despliegue V10 (2026-11-11)

Rama `vps/v10-ensayo`, sobre `deploy/vps-production` (55cd938). Docker del PC Compute, proyecto `llenamos-ensayo`.
Cómo repetirlo: `deploy/vps/ensayo/README.md`. Aquí van resultados y hallazgos.

## Qué funcionó

| Paso | Resultado |
| --- | --- |
| Imágenes web, gateway, API y copias | Construidas con los Dockerfile de `deploy/vps` y `apps/api`, sin registro. |
| Compose completo | web, gateway, API, worker, PostgreSQL 18 e identidad de ensayo sanos; solo `127.0.0.1:18080` publicado. |
| Migración | Rol bootstrap en proceso aparte (`migrate`), logins de API, worker, webhook y copias sin superusuario ni BYPASSRLS (copias: BYPASSRLS de solo lectura). `/readyz` correcto por el gateway. |
| Memoria (límites del plan) | Máximos durante la carga: API 63/512, worker 35/256, web 79/1024, gateway 17/128, PostgreSQL 214/768 MiB. |
| Recorrido | 24 de 24 pasos: alta por LogiQD, invitación y aceptación de propietaria, camarero y cocina; sesión revocada; plano, carta y estaciones; reserva pública con cambio en vivo en el panel (≈160 ms); pedido que llega a cocina en vivo (≈110 ms); cobro en efectivo repetido en paralelo con un solo pago; cierre de caja; foto subida por nginx y servida pública con `max-age=300`; abuso (campo trampa, token falso, 429 por IP). |
| Worker sin proveedores | Un `mensaje.enviar` termina `not_configured` / `not-configured`, nunca como enviado. |
| Copia y restauración | `backup` y `ledger` del compose: 11 MB cifrados para 233 MB de base, 3 s; sin datos en claro; restauración aislada superada en 9 s (hashes, recuentos, RLS entre restaurantes, 274 elementos de cola en cuarentena, credenciales revocadas, hashes de archivos); copia manipulada y clave equivocada rechazadas. |
| Identidad de ensayo | Rechazada por la imagen de producción (6 variantes) y por la guardia de release. |

## Carga (3 restaurantes, 120 días cada uno)

Histórico clonado por SQL desde documentos reales creados por la API: 12 061 reservas, 21 559 sesiones de mesa, 43 118 líneas, 21 559 cuentas y
cobros, 4 504 clientes y 55 348 eventos; base de 233 MB. Medido desde el host a través de nginx, con el generador a 14 peticiones por segundo
(nginx limita a 20 por IP) y descontando la espera del generador. Tiempos en ms.

| Operación | n | ok | p50 | p95 | máx | nota |
| --- | --- | --- | --- | --- | --- | --- |
| SSE reservasDia (día con ~45 reservas) | 15 | 15 | 6 | 11 | 11 | primera foto |
| SSE reservasDia (mañana) | 15 | 15 | 3 | 4 | 4 | |
| SSE plano / listaEsperaDia | 15 | 15 | 4 / 3 | 5 / 8 | 5 / 8 | |
| SSE clientes (primera página) | 15 | 15 | 26 | 33 | 33 | |
| SSE clientes (búsqueda) | 15 | 15 | 20 | 22 | 22 | |
| SSE salaServicio / salaCarta | 15 | 15 | 4 / 5 | 13 / 11 | 13 / 11 | |
| SSE salaHistorial (~7 000 sesiones por local) | 15 | 15 | 12 | 21 | 21 | |
| SSE cocinaLineas | 15 | 15 | 3 | 5 | 5 | |
| SSE cajaCuentas / cajaHistorial (100) / cajaTurnos | 15 | 15 | 3 / 6 / 4 | 6 / 13 / 7 | 6 / 13 / 7 | |
| consultarDisponibilidad (pública) | 30 | 30 | 34 | 37 | 38 | |
| crearReservaPublica (pública) | 24 | 8 | 40 | 43 | 43 | 8 por hora por IP y restaurante; 3 con 429; 13 con 412 «franja no disponible» (horas fuera del horario por defecto) |
| crearReserva (personal) | 25 | 25 | 48 | 50 | 51 | |
| Ciclo de mesa completo, secuencial | 18 | 18 | 194 | 340 | 340 | fases: abrir 73, pedido 74, servir 162, cuenta 208, cobro 76, cerrar 72 (p50) |
| Ciclo de mesa en paralelo (12 a la vez) | 24 | 24 | 270 | 441 | 450 | |
| 24 lecturas SSE a la vez | 72 | 72 | 5 | 6 | 16 | |
| Fan-out: 20 pantallas ven una mesa nueva | 20 | 20 | 175 | 327 | 327 | |
| 30 conexiones SSE desde una IP | 30 | 24 | | | | 6 con 429: `limit_conn live_per_ip 24` de nginx |
| 12 pedidos concurrentes en un restaurante | 12 | 12 | 20 | 26 | 26 | |

### Consultas lentas (> 20 ms en el registro de PostgreSQL)

Solo hay una familia, ejecutada 76 veces (p50 ≈ 40 ms, hasta 176 ms con más histórico en pruebas previas), en
`apps/api/src/modules/reservas/store.ts:39`:

```sql
SELECT id,data FROM llenamos.reservations r WHERE restaurant_id=$1 AND location_id=$2 AND status=ANY($3) AND NOT privacy_redacted
  AND EXISTS(SELECT 1 FROM unnest($4::timestamptz[],$5::timestamptz[]) w(f,t) WHERE r.start_at>=w.f AND r.start_at<w.t) ORDER BY start_at,id
```

Plan real (local con 4 024 reservas): `Seq Scan` sobre `reservations`, 3 631 filas leídas y 3 328 descartadas por el filtro del semijoin para devolver 3
(1 518 buffers). El rango dentro de `EXISTS(unnest …)` no se puede usar como condición de índice, así que el coste crece con todo el histórico del
local. Con `r.start_at>=$4 AND r.start_at<$5` (una ventana, o `OR` de ventanas) el plan es `Index Scan using reservations_day`, 15 buffers, ≈0,05 ms.
No lo he cambiado: es del módulo de reservas.

Plan actual (`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF)`):

```
 Sort (actual rows=3.00 loops=1)
   Sort Key: r.start_at, r.id
   Sort Method: quicksort  Memory: 27kB
   Buffers: shared hit=1518
   ->  Nested Loop Semi Join (actual rows=3.00 loops=1)
         Join Filter: ((r.start_at >= w.f) AND (r.start_at < w.t))
         Rows Removed by Join Filter: 3628
         Buffers: shared hit=1512
         ->  Seq Scan on reservations r (actual rows=3631.00 loops=1)
               Filter: ((NOT privacy_redacted) AND ((restaurant_id)::text = 'rest_cc52aae872835afa5963a1187f62d7a7'::text) AND ((location_id)::text = 'principal'::text) A
               Rows Removed by Filter: 8463
               Buffers: shared hit=1512
         ->  Function Scan on w (actual rows=1.00 loops=3631)
 Planning:
   Buffers: shared hit=302
 Planning Time: 0.482 ms
 Execution Time: 4.636 ms
(17 rows)
```

Plan con el rango directo:

```
 Incremental Sort (actual rows=3.00 loops=1)
   Sort Key: start_at, id
   Presorted Key: start_at
   Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 27kB  Peak Memory: 27kB
   Buffers: shared hit=15
   ->  Index Scan using reservations_day on reservations r (actual rows=3.00 loops=1)
         Index Cond: (((restaurant_id)::text = 'rest_cc52aae872835afa5963a1187f62d7a7'::text) AND ((location_id)::text = 'principal'::text) AND (start_at >= '2026-11-12 1
         Filter: ((NOT privacy_redacted) AND (status = ANY ('{pending,confirmed,seated,finished}'::text[])))
         Index Searches: 1
         Buffers: shared hit=6
 Planning:
   Buffers: shared hit=289
 Planning Time: 0.500 ms
 Execution Time: 0.084 ms
(14 rows)
```

## Hallazgos en módulos (no arreglados)

1. **Sala no ve el plano que guarda reservas.** `apps/api/src/modules/sala/context.ts:25` lee `sala_tables`; `reservas/floor.ts:31` y `reservas/store.ts:27`
   escriben y leen `dining_tables`. Escenario: alta, `guardarPlano` como propietaria, `abrirMesa` t1 como camarero → 412 «Las mesas elegidas no están
   disponibles». El ensayo copia `dining_tables` a `sala_tables` por SQL (lo anticipa `modules/sala/README.md`, pero nadie lo hace).
2. **Ningún aviso de reserva ni de recogida sale.** `reservas/notices.ts:8` encola `aviso.mensaje` y `sala/context.ts:244` `aviso.recogida`, pero ningún
   módulo declara `workerHandlers` y el worker solo maneja `mensaje.enviar`. Las filas quedan `pending` con `last_error='sin-manejador'`, aplazadas para
   siempre; ni siquiera llegan a `not_configured`. Con el mismo payload como `mensaje.enviar` el worker sí responde `not_configured`.
3. **Consulta de reservas por ventanas con barrido del histórico** (arriba), `reservas/store.ts:39`.
4. Con el módulo de reservas, las reservas no ocupan mesas en sala (`modules/sala/README.md`, pendiente de V3): no comprobado, ya documentado por V4.

## Cambios míos fuera de mi terreno estricto

- `apps/api/src/config.ts`, `main.ts`, nuevo `rehearsal-identity.ts` (+ pruebas): la vía de identidad de ensayo que pedía el encargo. Sin la variable no cambia nada.
- `deploy/vps/compose.yaml`: `ip_range` en la red de aplicación. El gateway tiene la IP fija 172.30.43.3 (la única de confianza para `X-Real-IP`), pero el resto de
  servicios recibían IP dinámicas desde `.2`: en el ensayo `identity` se quedó con `.3` y el gateway no arrancó («Address already in use»). Ahora las dinámicas salen de `.8/29`.
- `deploy/vps/release.sh`: ejecuta `check-no-rehearsal.sh` antes de nada (sigue deteniéndose después, como estaba).

## Pendiente o no probado

- Personal, clientes y facturación: no existen aún en esta rama; no hay ensayo posible.
- Interfaz web con login real: requiere Firebase Auth en la nube. Solo se comprobó HTML de páginas públicas y el tráfico de la API.
- Correo real, WhatsApp, Stripe y fiscal: sin proveedores por diseño.
- Destino externo real de las copias (rsync/rclone) y reconciliación de UID de Firebase tras restaurar.
- Túnel y cabeceras de IP real de cloudflared (172.30.42.2): no se arrancó el túnel; la API ve la IP del host por el puerto publicado.
- Pico de memoria de PostgreSQL con `shared_buffers` real en un VPS de 8 GB compartido con n8n, Repite y HQ.
