-- Análisis (V7, fase 5): tablas resumen, resúmenes diarios, ajustes, automatizaciones, eventos y recomendaciones.
-- Regla de diseño: el panel NUNCA lee cuentas, pagos ni reservas. Solo `analytics_days` (una fila por local y día,
-- por clave primaria) y, para hoy, el cálculo vivo del puerto de hechos. Ejecutar con el rol bootstrap.

-- Instantánea diaria por local. `totals` es MetricTotals de core; `hours` y `dishes` están guardados para poder SUMAR días:
--   hours  = {"slotMinutes":15,"slots":[{"slot":"13:15","guests":4,"bills":1,"salesCents":4200,"reservations":2,"reservationCovers":6}]}
--            (tramos de 15 minutos; 30 y 60 se obtienen agrupando por suelo del minuto de inicio)
--   dishes = {"rows":[{"itemId":"…","name":"…","units":3,"unitsInMenu":1,"salesCents":2400}],"zero":[{"itemId":"…","name":"…"}]}
--            (rows = platos vendidos ese día; zero = platos activos de la carta sin ventas ese día)
--   margin = {"netCents":…,"coveredNetCents":…,"costCents":…,"wasteCostCents":…,"units":…,"coveredUnits":…} o NULL sin datos de coste
CREATE TABLE llenamos.analytics_days (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  location_id varchar(128) NOT NULL,
  date date NOT NULL,
  totals jsonb NOT NULL,
  hours jsonb NOT NULL DEFAULT '{"slotMinutes":15,"slots":[]}',
  dishes jsonb NOT NULL DEFAULT '{"rows":[],"zero":[]}',
  margin jsonb,
  source_version integer NOT NULL DEFAULT 1,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY(restaurant_id,location_id,date),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);

CREATE TABLE llenamos.analytics_settings (
  restaurant_id varchar(128) PRIMARY KEY REFERENCES llenamos.restaurants(id),
  settings jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Un resumen por día (global del restaurante). `sent_to` guarda el estado al preparar; el estado real sale del outbox.
CREATE TABLE llenamos.daily_summaries (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  date date NOT NULL,
  text text NOT NULL CHECK(length(text)<=4000),
  totals jsonb NOT NULL,
  sent_to jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,date)
);

-- Reglas de automatización (como mucho 100 por restaurante, lo impone la operación).
-- `cursor_at` es el punto hasta el que se han evaluado los eventos; NULL = desde hace 92 días (regla nueva o cambiada).
CREATE TABLE llenamos.automation_rules (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(128) NOT NULL,
  name varchar(80) NOT NULL,
  revision integer NOT NULL CHECK(revision>=1),
  rule jsonb NOT NULL,
  location_ids text[] NOT NULL DEFAULT '{}',
  cursor_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY(restaurant_id,id)
);
CREATE INDEX automation_rules_name ON llenamos.automation_rules(restaurant_id,name,id);

-- Eventos que las reglas evalúan. Retención acotada: la purga (`purgeAutomationEvents`) borra los de más de 100 días.
CREATE TABLE llenamos.automation_events (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(200) NOT NULL,
  type text NOT NULL CHECK(type IN ('reservation.no_show','reservation.cancelled','forecast.low_occupancy','forecast.high_occupancy','stock.low','customer.lapsed','day.closed')),
  location_id varchar(128),
  subject varchar(200) NOT NULL,
  at timestamptz NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  redacted boolean NOT NULL DEFAULT false,
  PRIMARY KEY(restaurant_id,id)
);
CREATE INDEX automation_events_at ON llenamos.automation_events(restaurant_id,at,id);
CREATE INDEX automation_events_type_at ON llenamos.automation_events(restaurant_id,type,at,id);

CREATE TABLE llenamos.recommendations (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(300) NOT NULL,
  rule_id varchar(128) NOT NULL,
  event_id varchar(200) NOT NULL,
  event_type text NOT NULL,
  location_id varchar(128),
  subject varchar(200) NOT NULL,
  kind text NOT NULL CHECK(kind IN ('require_deposit','contact_customer','launch_campaign','open_waitlist','adjust_staffing','review_stock','review_day')),
  text varchar(300) NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','dismissed','expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz,
  note varchar(200),
  PRIMARY KEY(restaurant_id,id)
);
CREATE INDEX recommendations_recent ON llenamos.recommendations(restaurant_id,created_at DESC,id);
CREATE INDEX recommendations_status ON llenamos.recommendations(restaurant_id,status,created_at DESC);
CREATE INDEX recommendations_expiry ON llenamos.recommendations(restaurant_id,expires_at,id) WHERE status='open';
CREATE INDEX recommendations_cooldown ON llenamos.recommendations(restaurant_id,rule_id,subject,created_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['analytics_days','analytics_settings','daily_summaries','automation_rules','automation_events','recommendations'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_access ON llenamos.%I USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id))',t);
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator',t);
  END LOOP;
END $$;
-- Mínimos: instantáneas y recomendaciones no se borran; los resúmenes solo se crean; reglas y eventos sí (borrado / purga).
GRANT SELECT,INSERT,UPDATE ON llenamos.analytics_days,llenamos.analytics_settings,llenamos.recommendations TO llenamos_app;
GRANT SELECT,INSERT ON llenamos.daily_summaries TO llenamos_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON llenamos.automation_rules,llenamos.automation_events TO llenamos_app;

-- La API (y el worker) solo ven su propia fila de memberships. Para validar y resolver los destinatarios del resumen
-- diario hace falta leer la de otros miembros: esta función devuelve solo uid, rol, estado, locales y correo de los uids
-- pedidos (máximo 50), del restaurante fijado en la transacción y solo a un miembro activo de él o al worker.
CREATE FUNCTION llenamos.analytics_recipients(rid text, uids text[]) RETURNS TABLE(uid text, role text, active boolean, location_ids text[], email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT m.uid,m.role,m.active,m.location_ids,m.email::text FROM llenamos.memberships m
  WHERE m.restaurant_id=rid AND m.uid=ANY(uids) AND cardinality(uids)<=50
    AND rid=nullif(current_setting('app.restaurant_id',true),'')
    AND NOT llenamos.is_platform()
    AND (EXISTS(SELECT FROM llenamos.memberships a WHERE a.restaurant_id=rid AND a.uid=llenamos.actor_uid() AND a.active)
      OR (CASE WHEN EXISTS(SELECT FROM pg_roles WHERE rolname='llenamos_worker') THEN pg_has_role(session_user,'llenamos_worker','member') ELSE false END))
$$;
ALTER FUNCTION llenamos.analytics_recipients(text,text[]) OWNER TO llenamos_migrator;
REVOKE ALL ON FUNCTION llenamos.analytics_recipients(text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.analytics_recipients(text,text[]) TO llenamos_app;
