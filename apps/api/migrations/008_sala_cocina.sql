-- Carta, sala, cocina, barra y recogida (V4). Cada documento conserva el contrato de
-- `@llenamos/core` en `doc`; las columnas generadas son solo para filtrar con índice.
-- Todas las tablas llevan restaurante y local, RLS FORCE y solo los GRANT mínimos.

DO $$
DECLARE spec record;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('sala_menu_categories', ''),
    ('sala_menu_items', ', category_id text GENERATED ALWAYS AS (doc->>''categoryId'') STORED'),
    ('sala_daily_menus', ''),
    ('sala_stations', ''),
    ('sala_task_keys', ', dest text GENERATED ALWAYS AS (doc->>''dest'') STORED'),
    ('sala_table_sessions', ', status text GENERATED ALWAYS AS (doc->>''status'') STORED, merged_into text GENERATED ALWAYS AS (doc->>''mergedInto'') STORED, closed_at bigint GENERATED ALWAYS AS ((doc->>''closedAt'')::bigint) STORED'),
    ('sala_orders', ', status text GENERATED ALWAYS AS (doc->>''status'') STORED, session_id text GENERATED ALWAYS AS (doc->>''sessionId'') STORED, takeaway_id text GENERATED ALWAYS AS (doc->>''takeawayId'') STORED'),
    ('sala_order_lines', ', status text GENERATED ALWAYS AS (doc->>''status'') STORED, session_id text GENERATED ALWAYS AS (doc->>''sessionId'') STORED, takeaway_id text GENERATED ALWAYS AS (doc->>''takeawayId'') STORED, order_id text GENERATED ALWAYS AS (doc->>''orderId'') STORED, station_id text GENERATED ALWAYS AS (doc->>''stationId'') STORED, station_kind text GENERATED ALWAYS AS (doc->>''stationKind'') STORED'),
    ('sala_floor_tasks', ', status text GENERATED ALWAYS AS (doc->>''status'') STORED, session_id text GENERATED ALWAYS AS (doc->>''sessionId'') STORED, takeaway_id text GENERATED ALWAYS AS (doc->>''takeawayId'') STORED'),
    ('sala_takeaways', ', status text GENERATED ALWAYS AS (doc->>''status'') STORED, pickup_at bigint GENERATED ALWAYS AS ((doc->>''pickupAt'')::bigint) STORED, reference text GENERATED ALWAYS AS (doc->>''reference'') STORED')
  ) AS t(name, extra) LOOP
    EXECUTE format($f$CREATE TABLE llenamos.%I (
      restaurant_id varchar(128) NOT NULL,
      location_id varchar(128) NOT NULL,
      id varchar(128) NOT NULL,
      doc jsonb NOT NULL,
      revision bigint NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
      %s,
      PRIMARY KEY(restaurant_id,location_id,id),
      FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
    )$f$, spec.name, spec.extra);
  END LOOP;
END $$;

-- Lecturas acotadas: solo lo vivo se carga en una operación; el histórico se pagina por estado y fecha.
CREATE INDEX sala_sessions_active ON llenamos.sala_table_sessions(restaurant_id,location_id) WHERE status IN ('open','bill_requested');
CREATE INDEX sala_sessions_closed ON llenamos.sala_table_sessions(restaurant_id,location_id,closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX sala_sessions_merged ON llenamos.sala_table_sessions(restaurant_id,location_id,merged_into) WHERE merged_into IS NOT NULL;
CREATE INDEX sala_orders_destination ON llenamos.sala_orders(restaurant_id,location_id,session_id);
CREATE INDEX sala_orders_takeaway ON llenamos.sala_orders(restaurant_id,location_id,takeaway_id) WHERE takeaway_id IS NOT NULL;
CREATE INDEX sala_lines_session ON llenamos.sala_order_lines(restaurant_id,location_id,session_id) WHERE session_id IS NOT NULL;
CREATE INDEX sala_lines_takeaway ON llenamos.sala_order_lines(restaurant_id,location_id,takeaway_id) WHERE takeaway_id IS NOT NULL;
CREATE INDEX sala_lines_station ON llenamos.sala_order_lines(restaurant_id,location_id,station_id,station_kind,status);
CREATE INDEX sala_lines_order ON llenamos.sala_order_lines(restaurant_id,location_id,order_id);
CREATE INDEX sala_tasks_active ON llenamos.sala_floor_tasks(restaurant_id,location_id) WHERE status IN ('open','claimed');
CREATE INDEX sala_tasks_session ON llenamos.sala_floor_tasks(restaurant_id,location_id,session_id) WHERE session_id IS NOT NULL;
CREATE INDEX sala_takeaways_active ON llenamos.sala_takeaways(restaurant_id,location_id,pickup_at) WHERE status IN ('pending','accepted','ready');
CREATE INDEX sala_task_keys_dest ON llenamos.sala_task_keys(restaurant_id,location_id,dest);
CREATE INDEX sala_takeaways_pickup ON llenamos.sala_takeaways(restaurant_id,location_id,pickup_at);
CREATE UNIQUE INDEX sala_takeaways_reference ON llenamos.sala_takeaways(restaurant_id,reference);

-- Ajustes del local: `floor` (sala y cocina) y `reservations` (horarios y duración; hasta que
-- reservas exponga su propio origen, ver `modules/sala/README.md`).
CREATE TABLE llenamos.sala_settings (
  restaurant_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  kind text NOT NULL CHECK(kind IN ('floor','reservations')),
  doc jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY(restaurant_id,location_id,kind),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
-- Secretos del servicio: enlaces de mesa, seguimiento de recogidas y suscripciones push. Los valores
-- reversibles (`tokenSecret`, claves push) viajan cifrados con la custodia del servidor (AES-GCM); en SQL
-- solo quedan hashes legibles. Las claves de tareas no son secretas y viven en `sala_task_keys`.
CREATE TABLE llenamos.sala_private (
  restaurant_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  kind text NOT NULL CHECK(kind IN ('tableTokens','takeawaySecrets','pushSubscriptions')),
  id varchar(128) NOT NULL,
  doc jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,location_id,kind,id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
-- Recibo de envíos con `requestId`: repetir devuelve el mismo resultado sin duplicar la comanda.
CREATE TABLE llenamos.sala_submissions (
  restaurant_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  key char(64) NOT NULL,
  fingerprint char(64) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,location_id,key),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
-- Contadores antiabuso de las operaciones públicas. Solo los toca `sala_rate_limit`.
CREATE TABLE llenamos.sala_rate_limits (
  bucket char(64) PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL
);
CREATE INDEX sala_rate_limits_old ON llenamos.sala_rate_limits(window_start);
CREATE INDEX sala_submissions_age ON llenamos.sala_submissions(restaurant_id,location_id,created_at);

-- Alcance de una operación pública: el restaurante y el local que acaba de resolver `sala_public_scope`.
CREATE FUNCTION llenamos.sala_public_scope_id() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.sala_public',true),'')
$$;
CREATE FUNCTION llenamos.sala_public_location_id() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.sala_public_location',true),'')
$$;
GRANT EXECUTE ON FUNCTION llenamos.sala_public_scope_id(),llenamos.sala_public_location_id() TO llenamos_app,llenamos_migrator;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sala_menu_categories','sala_menu_items','sala_daily_menus','sala_stations','sala_table_sessions','sala_orders','sala_order_lines','sala_floor_tasks','sala_takeaways','sala_task_keys','sala_settings','sala_private','sala_submissions'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator',t);
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_access ON llenamos.%I USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id))',t);
    -- Operaciones públicas (QR de mesa, recogida): solo el local resuelto por `sala_public_scope`, nunca por cuenta.
    -- Los secretos solo abren los enlaces de mesa (lectura del hash) y los de seguimiento de recogidas; las
    -- suscripciones push quedan fuera.
    EXECUTE format('CREATE POLICY sala_public ON llenamos.%I USING(restaurant_id=llenamos.sala_public_scope_id() AND location_id=llenamos.sala_public_location_id()%s) WITH CHECK(restaurant_id=llenamos.sala_public_scope_id() AND location_id=llenamos.sala_public_location_id()%s)',
      t, CASE WHEN t='sala_private' THEN ' AND kind IN (''tableTokens'',''takeawaySecrets'')' ELSE '' END, CASE WHEN t='sala_private' THEN ' AND kind IN (''tableTokens'',''takeawaySecrets'')' ELSE '' END);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON llenamos.%I TO llenamos_app',t);
  END LOOP;
END $$;
-- Los recibos de envío caducan (7 días): es lo único que sala borra.
GRANT DELETE ON llenamos.sala_submissions TO llenamos_app;
ALTER TABLE llenamos.sala_rate_limits OWNER TO llenamos_migrator;
ALTER TABLE llenamos.sala_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.sala_rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_custody ON llenamos.sala_rate_limits TO llenamos_migrator USING(true) WITH CHECK(true);

-- Aditivas: la mesa pública deja eventos y avisos en la misma transacción que el hecho.
CREATE POLICY sala_public_insert ON llenamos.outbox FOR INSERT WITH CHECK(restaurant_id=llenamos.sala_public_scope_id());
-- `ON CONFLICT DO NOTHING` (ID estable) exige poder ver el aviso: solo los dos tipos de sala y sin datos personales.
CREATE POLICY sala_public_select ON llenamos.outbox FOR SELECT USING(restaurant_id=llenamos.sala_public_scope_id() AND kind IN ('aviso.recogida','plataforma.evento'));
CREATE POLICY sala_public_insert ON llenamos.events FOR INSERT WITH CHECK(restaurant_id=llenamos.sala_public_scope_id());
CREATE POLICY sala_public_dining_tables ON llenamos.dining_tables FOR SELECT USING(restaurant_id=llenamos.sala_public_scope_id() AND location_id=llenamos.sala_public_location_id());
CREATE POLICY sala_public_dining_areas ON llenamos.dining_areas FOR SELECT USING(restaurant_id=llenamos.sala_public_scope_id() AND location_id=llenamos.sala_public_location_id());
CREATE POLICY sala_custody ON llenamos.locations FOR SELECT TO llenamos_migrator USING(true);
-- Localizar una recogida por su referencia (el seguimiento público no trae el local).
CREATE POLICY sala_locate ON llenamos.sala_takeaways FOR SELECT TO llenamos_migrator USING(true);

GRANT EXECUTE ON FUNCTION llenamos.can_access_restaurant(text) TO llenamos_migrator;
-- Equipo del local visible para asignar responsables: solo dentro del restaurante del actor.
CREATE FUNCTION llenamos.sala_members(rid text) RETURNS TABLE(uid text,role text,active boolean,display_name text,location_ids text[])
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,llenamos AS $$
  SELECT m.uid,m.role,m.active,m.display_name,m.location_ids FROM llenamos.memberships m
  WHERE m.restaurant_id=rid AND llenamos.can_access_restaurant(rid)
$$;

CREATE FUNCTION llenamos.sala_slug_exists(p_slug text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,llenamos AS $$
  SELECT EXISTS(SELECT FROM llenamos.restaurants WHERE slug=p_slug)
$$;

-- Entrada pública: resuelve el restaurante por su dirección y abre el alcance (restaurante y local) de esta transacción.
CREATE FUNCTION llenamos.sala_public_scope(p_slug text,p_location text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE r llenamos.restaurants; l llenamos.locations;
BEGIN
  SELECT * INTO r FROM llenamos.restaurants WHERE slug=p_slug;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_location IS NOT NULL THEN
    SELECT * INTO l FROM llenamos.locations WHERE restaurant_id=r.id AND id=p_location;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  PERFORM set_config('app.sala_public',r.id,true),set_config('app.sala_public_location',coalesce(l.id,''),true);
  RETURN jsonb_build_object('restaurant',to_jsonb(r),'location',CASE WHEN l.id IS NULL THEN NULL ELSE to_jsonb(l) END);
END $$;
-- Local de una recogida dentro del restaurante ya resuelto, con el hash de su seguimiento.
CREATE FUNCTION llenamos.sala_takeaway_locate(p_reference text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog,llenamos AS $$
  SELECT jsonb_build_object('id',t.id,'locationId',t.location_id,'hash',t.doc->>'manageTokenHash')
  FROM llenamos.sala_takeaways t WHERE t.restaurant_id=llenamos.sala_public_scope_id() AND t.reference=p_reference
$$;

-- Ventana fija por cubo; devuelve false al pasar del límite. Se llama fuera de la transacción
-- de la operación para que los intentos fallidos también cuenten.
CREATE FUNCTION llenamos.sala_rate_limit(p_bucket text,p_limit integer,p_window_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE current_hits integer;
BEGIN
  IF p_limit<1 OR p_window_seconds<1 OR p_bucket !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'rate_limit_invalid'; END IF;
  INSERT INTO llenamos.sala_rate_limits(bucket,window_start,hits) VALUES(p_bucket,now(),1)
  ON CONFLICT(bucket) DO UPDATE SET
    hits=CASE WHEN llenamos.sala_rate_limits.window_start+make_interval(secs=>p_window_seconds)<=now() THEN 1 ELSE llenamos.sala_rate_limits.hits+1 END,
    window_start=CASE WHEN llenamos.sala_rate_limits.window_start+make_interval(secs=>p_window_seconds)<=now() THEN now() ELSE llenamos.sala_rate_limits.window_start END
  RETURNING hits INTO current_hits;
  DELETE FROM llenamos.sala_rate_limits WHERE bucket IN (SELECT bucket FROM llenamos.sala_rate_limits WHERE window_start<now()-interval '1 day' ORDER BY window_start LIMIT 20);
  RETURN current_hits<=p_limit;
END $$;

ALTER FUNCTION llenamos.sala_members(text) OWNER TO llenamos_migrator;
ALTER FUNCTION llenamos.sala_slug_exists(text) OWNER TO llenamos_migrator;
ALTER FUNCTION llenamos.sala_public_scope(text,text) OWNER TO llenamos_migrator;
ALTER FUNCTION llenamos.sala_takeaway_locate(text) OWNER TO llenamos_migrator;
ALTER FUNCTION llenamos.sala_rate_limit(text,integer,integer) OWNER TO llenamos_migrator;
REVOKE ALL ON FUNCTION llenamos.sala_members(text),llenamos.sala_slug_exists(text),llenamos.sala_public_scope(text,text),llenamos.sala_takeaway_locate(text),llenamos.sala_rate_limit(text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.sala_members(text),llenamos.sala_slug_exists(text),llenamos.sala_public_scope(text,text),llenamos.sala_takeaway_locate(text),llenamos.sala_rate_limit(text,integer,integer) TO llenamos_app;
