-- Cableado B (V11, segunda vuelta): sala y reservas comparten plano, ocupación y ajustes.
-- No edita migraciones ya fusionadas: todo lo nuevo va aquí.

-- Las políticas públicas de la mesa sobre el plano solo valen para el rol de la API (antes eran para PUBLIC).
ALTER POLICY sala_public_dining_tables ON llenamos.dining_tables TO llenamos_app;
ALTER POLICY sala_public_dining_areas ON llenamos.dining_areas TO llenamos_app;

-- Una sola fuente para horarios y duraciones: `reservation_settings`. La mesa pública (QR, recogida, carta)
-- la lee con el alcance de su local, igual que el plano.
CREATE POLICY sala_public_reservation_settings ON llenamos.reservation_settings FOR SELECT TO llenamos_app
  USING(restaurant_id=llenamos.sala_public_scope_id() AND location_id=llenamos.sala_public_location_id());

-- Sala localiza la sesión de una reserva por su id (sentar, terminar, bloquear mesas con la cuenta en cobro).
CREATE INDEX sala_sessions_reservation ON llenamos.sala_table_sessions(restaurant_id,location_id,(doc->>'reservationId'))
  WHERE doc->>'reservationId' IS NOT NULL;

-- Reservas necesita saber qué mesas tienen sesión abierta aunque la petición sea pública (disponibilidad web, ofertas
-- de la lista de espera, caducidad). Solo expone lo mínimo (mesas, comensales, hora de apertura y reserva de origen),
-- nunca nombres, notas ni consumo, y solo en el ámbito del restaurante de la transacción.
CREATE POLICY reservas_sessions_custody ON llenamos.sala_table_sessions FOR SELECT TO llenamos_migrator USING(true);
CREATE FUNCTION llenamos.reservas_open_sessions(p_rid text,p_lid text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  WITH RECURSIVE live AS (
    SELECT s.id,s.status,s.merged_into,s.doc FROM llenamos.sala_table_sessions s
    WHERE (llenamos.public_scope(p_rid) OR llenamos.can_access_restaurant(p_rid))
      AND s.restaurant_id=p_rid AND s.location_id=p_lid AND s.status IN ('open','bill_requested')
    UNION
    SELECT m.id,m.status,m.merged_into,m.doc FROM llenamos.sala_table_sessions m JOIN live ON m.merged_into=live.id
    WHERE m.restaurant_id=p_rid AND m.location_id=p_lid
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'mergedInto',merged_into,'tableIds',doc->'tableIds',
    'guests',doc->'guests','openedAt',doc->'openedAt','reservationId',doc->'reservationId') ORDER BY id),'[]'::jsonb) FROM live
$$;
ALTER FUNCTION llenamos.reservas_open_sessions(text,text) OWNER TO llenamos_migrator;
REVOKE ALL ON FUNCTION llenamos.reservas_open_sessions(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.reservas_open_sessions(text,text) TO llenamos_app;

-- Gasto del cliente por mesa cerrada o recogida entregada (`reconcileSpend` del original). Cada destino aporta una
-- cantidad absoluta: repetir la operación aplica una diferencia de cero. Solo el id del cliente (hash del teléfono).
CREATE TABLE llenamos.sala_spend (
  restaurant_id varchar(128) NOT NULL,
  target_kind text NOT NULL CHECK(target_kind IN ('session','takeaway')),
  target_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  customer_id varchar(128) NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,target_kind,target_id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE INDEX sala_spend_customer ON llenamos.sala_spend(restaurant_id,customer_id);
ALTER TABLE llenamos.sala_spend OWNER TO llenamos_migrator;
ALTER TABLE llenamos.sala_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.sala_spend FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON llenamos.sala_spend TO llenamos_app USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id));
GRANT SELECT,INSERT,UPDATE ON llenamos.sala_spend TO llenamos_app;

-- Una recogida pública crea la ficha del cliente si no existe (solo alta, nunca lectura ni cambio).
CREATE POLICY sala_public_customer_insert ON llenamos.customers FOR INSERT TO llenamos_app WITH CHECK(restaurant_id=llenamos.sala_public_scope_id());

-- `recordReservationOrigin` (campañas) inserta con `ON CONFLICT DO NOTHING`, que exige poder ver la fila: en el ámbito
-- público solo se ve la que esta misma transacción acaba de crear (mismo criterio que el aviso de la cola), nunca el
-- histórico de orígenes.
CREATE POLICY public_read ON llenamos.reservation_origins FOR SELECT TO llenamos_app
  USING(llenamos.public_scope(restaurant_id) AND created_at=now());
-- El resultado final de la reserva (`final_status`) también lo cambian las rutas públicas (gestión por enlace, señal
-- pagada), que no leen orígenes: función estrecha, solo ese campo y solo en el restaurante de la transacción.
CREATE FUNCTION llenamos.reservas_origin_outcome(p_rid text,p_reservation text,p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
  IF NOT (llenamos.public_scope(p_rid) OR llenamos.can_access_restaurant(p_rid)) THEN RETURN; END IF;
  UPDATE llenamos.reservation_origins SET final_status=p_status WHERE restaurant_id=p_rid AND reservation_id=p_reservation;
END $$;
ALTER FUNCTION llenamos.reservas_origin_outcome(text,text,text) OWNER TO llenamos_migrator;
REVOKE ALL ON FUNCTION llenamos.reservas_origin_outcome(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.reservas_origin_outcome(text,text,text) TO llenamos_app;

-- La señal de una reserva (un mismo id de pago de Stripe) se descuenta de la cuenta en varios cobros: el índice de
-- "una referencia externa, un cobro" vale para el datáfono y Stripe, no para la señal. Su tope (lo cobrado, una sola
-- vez) lo comprueba el cobro con la reserva y la cuenta bloqueadas.
DROP INDEX llenamos.pos_payments_external_once;
CREATE UNIQUE INDEX pos_payments_external_once ON llenamos.pos_payments(restaurant_id,method,external_id)
  WHERE kind='charge' AND status='succeeded' AND external_id IS NOT NULL AND method<>'deposit';

-- La suma de la señal aplicada (cobros con `deposit` de una sesión de pago) usa este índice, no recorre los cobros del local.
CREATE INDEX pos_payments_deposit ON llenamos.pos_payments(restaurant_id,location_id,external_id) WHERE method='deposit';

-- Una sola fuente de horarios: `reservation_settings`. Se limpian las copias antiguas de `sala_settings('reservations')`
-- (el alta de restaurantes las escribía) y se impide que vuelvan. La migración borra como dueña de la tabla: FORCE RLS
-- no le deja ver filas sin política, así que se quita un instante y se restablece.
ALTER TABLE llenamos.sala_settings NO FORCE ROW LEVEL SECURITY;
DELETE FROM llenamos.sala_settings WHERE kind='reservations';
ALTER TABLE llenamos.sala_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE llenamos.sala_settings ADD CONSTRAINT sala_settings_sin_reservas CHECK(kind<>'reservations');
