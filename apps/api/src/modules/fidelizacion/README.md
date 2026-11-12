# Fidelización, promociones y Repite (V7)

Puntos (libro inmutable + tandas), canjes, promociones y la cola hacia Repite. Migraciones `011b_fidelizacion.sql` y `016_clientes_revision.sql`.

## Libro de puntos

`loyalty_movements` solo admite SELECT e INSERT; ids deterministas; cuenta bloqueada con `FOR UPDATE`. Las tandas (`loyalty_lots`) son una
proyección: con más de 500 vivas se **compactan** (mismas ventanas de caducidad: día, semana, mes; conservan la caducidad más tardía del grupo,
nunca adelantan) en vez de abortar. Una devolución que no quita puntos no escribe movimiento. Motivos libres: `loyalty_anonymize` (worker).

## Conexión con caja (sin que caja conozca a fidelización)

`modules/comun/ganchos.ts`: caja llama a `emitBillSettled` / `emitBillRefunded` (una línea en `payments.ts` y otra en `accounts.ts`) y quien se
registra (`registerLoyaltyHooks`: `fidelizacion.puntos`, `fidelizacion.sello`, `fidelizacion.puntos_devolucion`) corre en un SAVEPOINT. Un gancho
que falla **no aborta el cobro**: se deshace solo su parte, se registra y se deja un trabajo `ganchos.reintentar` para el worker.
`cuentas.ts` implementa `BillPort` sobre las cuentas de caja (mismo cerrojo por local) y `VisitPort` sobre reservas y mesas de sala.
**Límite**: las líneas de caja no llevan plato ni categoría, así que los premios `item` y las promociones por plato/categoría no casan con ellas;
funcionan los premios `amount` y las promociones de cuenta.

## Repite

Sin adaptador real, toda operación termina `not_configured`; guardar ajustes no acredita nada. La cola ya no se atasca: una operación que no se
puede hacer (módulo apagado, Repite desactivado, comercio cambiado) se cierra (`not_configured` / `skipped`) y las que tienen lease vigente no
tapan a las demás. `fidelizacion.procesar_repite` repite pasadas mientras queden vencidas. `vincularRepite` (plataforma) usa `repite_link`
(016 le da a su propietario el EXECUTE que le faltaba).

## Trabajos del worker

`fidelizacion.procesar_repite`, `fidelizacion.expirar_puntos` (diario, lo programa `puntos-caducan`), `ganchos.reintentar`,
`clientes.reserva_cambiada` (lo encola un disparador de reservas: sello al sentar). Tareas periódicas en `comun/mantenimiento.ts`.

## Alcance de local

Una promoción sin locales vale para todos: solo quien no tiene locales limitados la toca o la ve. Las demás, solo si todos sus locales
(también los que tenía antes de editarla) están en su alcance. `aplicarPromocion` falla con 409 si otra aplicación ganó la carrera.

## Privacidad

`personalData` + `PrivacyContributor`. Los pasos van en tres tiempos del gestor: `blockers` (solo lectura: una llamada a Repite en curso, un mensaje de marketing en envío),
`prepare` (con efectos, y **solo si nadie bloquea**: así una reserva abierta no deja la tarjeta retirada con la persona sin borrar) y, tras el `erase` de todos, `finalize`.

Mientras la tarjeta siga activa en Repite el borrado se bloquea: `prepare` encola su `remove_card` (o reabre la que no salió) y hay que **verificar la solicitud
otra vez a mano** cuando la cola la termina (nada la repite sola). Para que la supresión no quede bloqueada para siempre: tras 3 verificaciones con la retirada sin
poder hacerse (Repite sin configurar o error definitivo), la tarjeta se da por retirada en local y se deja una **baja pendiente** en `repite_pending_removals` (comercio y
tarjeta, ids opacos de Repite, sin la persona). Plataforma las ve con `listarBajasRepitePendientes`, pide la baja a Repite y la marca con `resolverBajaRepite`.
`crearTarjetaRepite` reabre una `card.<id>` terminada: si salió bien (la persona vuelve tras retirar su tarjeta) con referencia nueva y apartando la retirada vieja, para que un borrado posterior retire la tarjeta NUEVA; si falló, conserva la referencia opaca (Repite pudo crearla) y reintenta con la misma clave. La baja pendiente la escribe solo `repite_register_removal` (worker), que toma comercio y tarjeta de la ficha; `resolverBajaRepite` da 404 si no existe o ya está resuelta, y el listado muestra las 500 más antiguas sin resolver. El gestor para en el primer `prepare` que bloquea.

Al borrar: cuenta cerrada (`verCuentaFidelizacion` no devuelve saldo ni movimientos), motivos anonimizados y lo pendiente en Repite anulado. En el `finalize`,
`marketing_rekey` cambia el id del cliente por uno aleatorio en todas las tablas de V7 y reescribe lo derivado del viejo: ids de permisos (`erasure.<id>`) y la prueba de
las bajas por enlace (`evidence_id`, que era el UUID del mensaje), ids de la cola de Repite (`card.`, `remove.`, `missyou.`), los UUID de mensaje de campaña (outbox, entregas,
destinatarios), y borra los trabajos y eventos que llevan el id. Las políticas `rekey_*` solo valen mientras esa función corre (bandera `app.rekey`). El id viejo sale
del teléfono sin sal, así que sin esto se podía reconstruir. Quien vuelve con ese teléfono recibe una tarjeta nueva. Al encender Repite se reabren solo los sellos `not_configured` de los últimos 7 días.

**Dependencia de V9:** los cambios posteriores de una reserva anterior de la persona no generan datos nuevos porque `reservations.privacy_redacted` la excluye de
`reservationChangedHandler`. **Conocido, sin resolver aquí:** `llenamos.idempotency` (plataforma) guarda un hash de la entrada (que lleva el id de cliente) y el resultado
de algunas operaciones (`crearTarjetaRepite` guarda el `cardId`); ni se borra ni se poda. Afecta a toda la plataforma y debe tratarse allí. Las claves de idempotencia hacia Repite
cambiaron de formato en esta rama: no hay operaciones en curso porque V7 no está desplegado; si en algún entorno las hubiera, habría que vaciar la cola antes.
