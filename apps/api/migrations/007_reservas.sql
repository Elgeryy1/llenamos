-- Reservas completas (V3): configuración, plano, clientes, reservas, espera, antiabuso.
-- Cada documento conserva el JSON validado por los esquemas de @llenamos/core en `data`; las columnas
-- sueltas existen solo para consultar con índice (fecha, estado, cliente, referencia) y para unicidad.

-- Ámbito público: la API fija `app.public_restaurant` tras resolver el slug, nunca el navegador.
CREATE FUNCTION llenamos.public_scope(rid text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT rid=nullif(current_setting('app.public_restaurant',true),'')
$$;
REVOKE ALL ON FUNCTION llenamos.public_scope(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.public_scope(text) TO llenamos_app,llenamos_migrator;
GRANT EXECUTE ON FUNCTION llenamos.can_access_restaurant(text) TO llenamos_migrator;

CREATE TABLE llenamos.reservation_settings (
  restaurant_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  data jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY(restaurant_id,location_id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE TABLE llenamos.dining_areas (
  restaurant_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  id varchar(128) NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE TABLE llenamos.dining_tables (
  restaurant_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  id varchar(128) NOT NULL,
  area_id varchar(128) NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id,area_id) REFERENCES llenamos.dining_areas(restaurant_id,location_id,id)
);
CREATE TABLE llenamos.customers (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id char(20) NOT NULL CHECK(id ~ '^[0-9a-f]{20}$'),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY(restaurant_id,id)
);
CREATE TABLE llenamos.reservations (
  restaurant_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  id varchar(128) NOT NULL,
  customer_id char(20) NOT NULL,
  reference varchar(12) NOT NULL,
  start_at timestamptz NOT NULL,
  status text NOT NULL CHECK(status IN ('pending','confirmed','seated','finished','cancelled','no_show')),
  table_ids text[] NOT NULL DEFAULT '{}',
  manage_token_hash char(64) NOT NULL CHECK(manage_token_hash ~ '^[0-9a-f]{64}$'),
  data jsonb NOT NULL,
  privacy_redacted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY(restaurant_id,location_id,id),
  UNIQUE(restaurant_id,reference),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE INDEX reservations_day ON llenamos.reservations(restaurant_id,location_id,start_at);
CREATE INDEX reservations_status_day ON llenamos.reservations(restaurant_id,location_id,status,start_at);
CREATE INDEX reservations_customer ON llenamos.reservations(restaurant_id,customer_id,start_at DESC);
CREATE TABLE llenamos.waitlist (
  restaurant_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  id varchar(128) NOT NULL,
  customer_id char(20) NOT NULL,
  service_date char(10) NOT NULL CHECK(service_date ~ '^\d{4}-\d{2}-\d{2}$'),
  status text NOT NULL CHECK(status IN ('waiting','offered','booked','expired','cancelled')),
  offer_token_hash char(64),
  offer_expires_at timestamptz,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE INDEX waitlist_day ON llenamos.waitlist(restaurant_id,location_id,service_date,created_at,id);
CREATE INDEX waitlist_open ON llenamos.waitlist(restaurant_id,location_id,status,created_at,id) WHERE status IN ('waiting','offered');
CREATE TABLE llenamos.reservation_origins (
  restaurant_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  reservation_id varchar(128) NOT NULL,
  channel text NOT NULL DEFAULT 'direct',
  paid boolean NOT NULL DEFAULT false,
  source varchar(100), medium varchar(100), campaign varchar(100), content varchar(100), term varchar(100),
  ad_id varchar(100),
  campaign_id varchar(64),
  click_ids text[] NOT NULL DEFAULT '{}',
  referrer_host varchar(253),
  embed_host varchar(253),
  reservation_source varchar(40) NOT NULL DEFAULT 'web',
  service_date date NOT NULL DEFAULT current_date,
  party_size integer NOT NULL DEFAULT 1 CHECK(party_size>=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  final_status text NOT NULL DEFAULT 'pending' CHECK(final_status IN ('pending','confirmed','seated','finished','cancelled','no_show')),
  sales_cents bigint NOT NULL DEFAULT 0 CHECK(sales_cents>=0),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(restaurant_id,reservation_id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE INDEX reservation_origins_date ON llenamos.reservation_origins(restaurant_id,location_id,service_date);
CREATE INDEX reservation_origins_campaign ON llenamos.reservation_origins(restaurant_id,campaign_id) WHERE campaign_id IS NOT NULL;
CREATE TABLE llenamos.consents (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(200) NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,id)
);
-- Contadores de abuso: solo los tocan `abuse_hit` y `abuse_count`; la API no tiene permisos directos.
CREATE TABLE llenamos.abuse_counters (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  scope varchar(60) NOT NULL,
  key_hash char(64) NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY(restaurant_id,scope,key_hash,window_start)
);
CREATE INDEX abuse_counters_old ON llenamos.abuse_counters(window_start);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['reservation_settings','dining_areas','dining_tables','customers','reservations','waitlist','reservation_origins','consents','abuse_counters'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator',t);
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY custody ON llenamos.%I TO llenamos_migrator USING(true) WITH CHECK(true)',t);
    IF t<>'abuse_counters' THEN
      EXECUTE format('CREATE POLICY tenant_access ON llenamos.%I TO llenamos_app USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id))',t);
    END IF;
  END LOOP;
END $$;
-- Ámbito público por comando: solo lo que cada operación anónima necesita.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['reservation_settings','dining_areas','dining_tables','customers','reservations','waitlist'] LOOP
    EXECUTE format('CREATE POLICY public_read ON llenamos.%I FOR SELECT TO llenamos_app USING(llenamos.public_scope(restaurant_id))',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['customers','reservations','waitlist'] LOOP
    EXECUTE format('CREATE POLICY public_insert ON llenamos.%I FOR INSERT TO llenamos_app WITH CHECK(llenamos.public_scope(restaurant_id))',t);
    EXECUTE format('CREATE POLICY public_update ON llenamos.%I FOR UPDATE TO llenamos_app USING(llenamos.public_scope(restaurant_id)) WITH CHECK(llenamos.public_scope(restaurant_id))',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['reservation_origins','consents'] LOOP
    EXECUTE format('CREATE POLICY public_insert ON llenamos.%I FOR INSERT TO llenamos_app WITH CHECK(llenamos.public_scope(restaurant_id))',t);
  END LOOP;
END $$;
-- Mínimo para operar: sin DELETE ni TRUNCATE (privacidad borra con su propio procedimiento).
GRANT SELECT,INSERT,UPDATE ON llenamos.reservation_settings,llenamos.dining_areas,llenamos.customers,llenamos.reservations,llenamos.waitlist TO llenamos_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON llenamos.dining_tables TO llenamos_app;
GRANT DELETE ON llenamos.dining_areas TO llenamos_app;
GRANT SELECT,INSERT ON llenamos.reservation_origins,llenamos.consents TO llenamos_app;

-- Reservas públicas encolan avisos y emiten eventos en su ámbito, sin leer lo de otros.
CREATE POLICY reservas_public_outbox ON llenamos.outbox FOR INSERT TO llenamos_app WITH CHECK(llenamos.public_scope(restaurant_id));
-- ON CONFLICT DO NOTHING comprueba también la política de lectura de la fila nueva: solo ve lo escrito en su propia transacción.
CREATE POLICY reservas_public_outbox_read ON llenamos.outbox FOR SELECT TO llenamos_app USING(llenamos.public_scope(restaurant_id) AND occurred_at=now());
-- Trabajos diferidos de reservas (caducar ofertas de espera) desde el ámbito público; ON CONFLICT exige también lectura.
CREATE POLICY reservas_public_jobs ON llenamos.jobs FOR INSERT TO llenamos_app WITH CHECK(llenamos.public_scope(restaurant_id) AND kind LIKE 'reservas.%');
CREATE POLICY reservas_public_jobs_read ON llenamos.jobs FOR SELECT TO llenamos_app USING(llenamos.public_scope(restaurant_id) AND kind LIKE 'reservas.%');
CREATE POLICY reservas_public_events ON llenamos.events FOR INSERT TO llenamos_app WITH CHECK(llenamos.public_scope(restaurant_id));
-- Cancelar avisos pendientes de una reserva sin borrar el rastro.
DO $$ DECLARE def text; BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='llenamos.outbox'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%quarantined%';
  IF def IS NOT NULL AND def NOT LIKE '%cancelled%' THEN
    EXECUTE format('ALTER TABLE llenamos.outbox DROP CONSTRAINT %I',(SELECT conname FROM pg_constraint WHERE conrelid='llenamos.outbox'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%quarantined%'));
    ALTER TABLE llenamos.outbox ADD CONSTRAINT outbox_status_check CHECK(status IN ('pending','leased','done','failed','quarantined','cancelled'));
  END IF;
END $$;

-- Los avisos llevan enlaces con token: solo owner y manager los leen por HTTP (el worker no tiene actor).
-- `occurred_at=now()` deja que quien encola vea lo que acaba de escribir (ON CONFLICT DO NOTHING lo comprueba).
CREATE POLICY reservas_notice_roles ON llenamos.outbox AS RESTRICTIVE FOR SELECT TO llenamos_app
  USING(kind<>'aviso.mensaje' OR llenamos.actor_uid() IS NULL OR occurred_at=now() OR EXISTS(SELECT 1 FROM llenamos.memberships m
    WHERE m.restaurant_id=outbox.restaurant_id AND m.uid=llenamos.actor_uid() AND m.active AND m.role IN ('owner','manager')));
CREATE INDEX outbox_notice_reservation ON llenamos.outbox(restaurant_id,(payload->>'reservationId')) WHERE kind='aviso.mensaje' AND status='pending';
-- Anular avisos pendientes de una reserva: función estrecha (no abre UPDATE de la cola al ámbito público).
CREATE POLICY reservas_notice_custody ON llenamos.outbox TO llenamos_migrator USING(true) WITH CHECK(true);
CREATE FUNCTION llenamos.reservas_cancel_notices(p_rid text,p_reservation text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE n integer;
BEGIN
  IF NOT (llenamos.public_scope(p_rid) OR llenamos.can_access_restaurant(p_rid)) THEN RAISE EXCEPTION 'reservas_denied'; END IF;
  UPDATE llenamos.outbox SET status='cancelled',payload=payload #- '{data,manageUrl}' #- '{data,offerUrl}' WHERE restaurant_id=p_rid AND kind='aviso.mensaje' AND status='pending' AND payload->>'reservationId'=p_reservation;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n;
END $$;

-- Lectura de locales para las funciones de custodia (los miembros ya tienen su política).
CREATE POLICY reservas_location_custody ON llenamos.locations FOR SELECT TO llenamos_migrator USING(true);

-- Resolución pública: slug (o id, para webhooks y trabajos) -> restaurante/local mínimos. Sin datos privados.
CREATE FUNCTION llenamos.reservas_public_resolve(p_rid text,p_slug text,p_location text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT jsonb_build_object('restaurantId',r.id,'name',r.name,'slug',r.slug,'timezone',r.timezone,'locale',r.locale,'plan',r.plan,
    'activeModules',to_jsonb(r.active_modules),'entitlementVersion',r.entitlement_version,'moduleOverrides',r.module_overrides,
    'accessOk',(r.entitlement_version IS NULL OR r.access_valid_until>now()),
    'accessValidUntil',CASE WHEN r.entitlement_version IS NULL THEN NULL ELSE (extract(epoch FROM r.access_valid_until)*1000)::bigint END,
    'locationId',l.id,'locationName',l.name,
    'stripe',coalesce((p.integration_status->'stripe'->>'configured')::boolean,false))
  FROM llenamos.restaurants r
  LEFT JOIN llenamos.locations l ON l.restaurant_id=r.id AND l.id=p_location
  LEFT JOIN llenamos.platform_restaurants p ON p.restaurant_id=r.id
  WHERE (p_rid IS NULL OR r.id=p_rid) AND (p_slug IS NULL OR r.slug=p_slug) AND (p_rid IS NOT NULL OR p_slug IS NOT NULL)
$$;
-- Proyección pública del restaurante (sustituye a `publicRestaurants/{slug}`): solo lo que se muestra en la web.
CREATE FUNCTION llenamos.reservas_public_projection(p_slug text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT jsonb_build_object('restaurantId',r.id,'name',r.name,'slug',r.slug,'brandColor',r.brand_color,'locale',r.locale,'timezone',r.timezone,'plan',r.plan,
    'activeModules',to_jsonb(r.active_modules),'moduleOverrides',r.module_overrides,'entitlementVersion',r.entitlement_version,
    'accessValidUntil',CASE WHEN r.entitlement_version IS NULL THEN NULL ELSE (extract(epoch FROM r.access_valid_until)*1000)::bigint END,
    'locations',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'address',l.address,'city',l.city,'phone',l.phone) ORDER BY l.id),'[]'::jsonb)
      FROM llenamos.locations l JOIN llenamos.reservation_settings s ON s.restaurant_id=l.restaurant_id AND s.location_id=l.id
      WHERE l.restaurant_id=r.id AND s.data->>'publicBooking'='true'),
    'settings',(SELECT s.data FROM llenamos.locations l LEFT JOIN llenamos.reservation_settings s ON s.restaurant_id=l.restaurant_id AND s.location_id=l.id
      WHERE l.restaurant_id=r.id ORDER BY l.id LIMIT 1))
  FROM llenamos.restaurants r WHERE r.slug=p_slug
$$;
-- Credenciales de enlace: valida referencia + hash antes de cargar contexto alguno.
CREATE FUNCTION llenamos.reservas_link_lookup(p_rid text,p_reference text,p_hash text) RETURNS TABLE(location_id text,reservation_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT x.location_id::text,x.id::text FROM llenamos.reservations x
  WHERE x.restaurant_id=p_rid AND x.reference=p_reference AND x.manage_token_hash=p_hash AND NOT x.privacy_redacted
$$;
-- Oferta de espera: localiza la entrada por id + hash del token.
CREATE FUNCTION llenamos.reservas_offer_lookup(p_rid text,p_waitlist text,p_hash text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT w.location_id::text FROM llenamos.waitlist w WHERE w.restaurant_id=p_rid AND w.id=p_waitlist AND w.offer_token_hash=p_hash
$$;
-- Contador de ventana fija. Se llama en su propia transacción para que un rechazo cuente.
CREATE FUNCTION llenamos.abuse_hit(p_rid text,p_scope text,p_key text,p_window integer,p_limit integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE w timestamptz; h integer;
BEGIN
  IF p_window NOT BETWEEN 1 AND 86400 OR p_limit<1 OR p_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'abuse_invalid'; END IF;
  w:=to_timestamp(floor(extract(epoch FROM now())/p_window)*p_window);
  INSERT INTO llenamos.abuse_counters(restaurant_id,scope,key_hash,window_start,hits) VALUES(p_rid,p_scope,p_key,w,1)
    ON CONFLICT(restaurant_id,scope,key_hash,window_start) DO UPDATE SET hits=llenamos.abuse_counters.hits+1 RETURNING hits INTO h;
  DELETE FROM llenamos.abuse_counters WHERE ctid IN (SELECT ctid FROM llenamos.abuse_counters WHERE window_start<now()-interval '2 days' LIMIT 20);
  RETURN h<=p_limit;
END $$;
-- Consulta sin sumar: bloquea de verdad tras los fallos (el contador de fallos se sube aparte).
CREATE FUNCTION llenamos.abuse_count(p_rid text,p_scope text,p_key text,p_window integer) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT coalesce((SELECT hits FROM llenamos.abuse_counters WHERE restaurant_id=p_rid AND scope=p_scope AND key_hash=p_key
    AND window_start=to_timestamp(floor(extract(epoch FROM now())/p_window)*p_window)),0)
$$;
CREATE INDEX customers_name ON llenamos.customers(restaurant_id,(data->>'name'),id);
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='llenamos' AND p.proname IN ('reservas_public_resolve','reservas_public_projection','reservas_link_lookup','reservas_offer_lookup','reservas_cancel_notices','abuse_hit','abuse_count') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO llenamos_migrator',f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO llenamos_app',f);
  END LOOP;
END $$;
