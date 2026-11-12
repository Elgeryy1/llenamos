# Análisis, resumen diario y automatizaciones (V7)

Panel por instantáneas (`analytics_days`), exportaciones, previsión, resumen diario, reglas de automatización y recomendaciones.
Migraciones `011d_analisis.sql` y `016_clientes_revision.sql`.

## De dónde salen los datos

El panel **nunca lee cuentas, pagos ni reservas**: lee `analytics_days` (una fila por local y día) y, para hoy, calcula en vivo con el puerto de
hechos. `hechos.ts` es ese puerto sobre PostgreSQL: cuentas cobradas del día (`pos_bills`, índice de estado y apertura, ventana de 3 días),
cobros y devoluciones (`pos_payments`), mesas y líneas de sala, reservas del día (`reservations_day`), mesas y horarios de reservas, carta de
sala y costes congelados de inventario. La previsión de ocupación usa `postgresReservationsPort`. Se conectan solos (`comun/conexion.ts`).
Límite: una cuenta abierta hace más de 3 días y cobrada hoy no entra en el día.

## Trabajos periódicos (worker, `comun/mantenimiento.ts`)

| Tarea | Cada | Qué hace |
| --- | --- | --- |
| `resumen-diario` | 15 min | `sendDailySummary`: un resumen por día; deja un `mensaje.enviar` por persona y canal (ID determinista). |
| `automatizaciones` | 5 min | `evaluateAutomations` + `expireRecommendations`. |
| `analisis-diario` | 3 h | `dailyEvents` (clientes que no vuelven, previsión), instantáneas de los últimos 4 días, purga de eventos de más de 100 días. |

Los eventos de reservas (no presentado, cancelada) los anota el worker al recibir `clientes.reserva_cambiada` (disparador de reservas).
`recordStockLowEvent` espera a que inventario lo llame al abrir una alerta.

## Permisos

`analytics_recipients` solo la consulta propietario, encargado o el worker. Reglas y recomendaciones respetan el alcance de local (un encargado
limitado no toca reglas de todo el restaurante). El resumen diario es global: no lo ve ni lo recibe quien tiene locales limitados.

## Privacidad

`personalData` + `PrivacyContributor`: exporta y borra los eventos de automatización del cliente y deja las recomendaciones sin sujeto ni pruebas.

## Pruebas

`pruebas/dobles.ts` y `pruebas/prueba.ts` son soportes de pruebas (no se importan desde código productivo).
