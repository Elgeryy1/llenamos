-- Base común de fidelización, campañas y análisis (V7). Sin FK a clientes: la ficha de cliente la porta V3;
-- hasta entonces esta proyección mínima se rellena con `upsertCustomerMarketing` (modules/comun/clientes.ts).
CREATE TABLE llenamos.customer_marketing (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  customer_id char(20) NOT NULL CHECK(customer_id ~ '^[0-9a-f]{20}$'),
  name varchar(120) NOT NULL DEFAULT '',
  phone varchar(30),
  email varchar(254),
  language text NOT NULL DEFAULT 'es' CHECK(language IN ('es','ca','en')),
  visits integer NOT NULL DEFAULT 0 CHECK(visits>=0),
  no_shows integer NOT NULL DEFAULT 0 CHECK(no_shows>=0),
  last_visit_at timestamptz,
  spent_cents bigint NOT NULL DEFAULT 0 CHECK(spent_cents>=0),
  tags text[] NOT NULL DEFAULT '{}',
  redacted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,customer_id)
);
CREATE INDEX customer_marketing_last_visit ON llenamos.customer_marketing(restaurant_id,last_visit_at) WHERE NOT redacted;
-- Permisos de marketing como libro de eventos inmutable (el último evento decide; en empate gana la baja).
CREATE TABLE llenamos.marketing_consents (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(200) NOT NULL,
  customer_id char(20) NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('marketing_email','marketing_whatsapp','digital_receipt')),
  status text NOT NULL CHECK(status IN ('granted','withdrawn')),
  policy_version varchar(80) NOT NULL,
  at timestamptz NOT NULL,
  source text NOT NULL CHECK(source IN ('public','staff','import')),
  evidence_id varchar(128) NOT NULL,
  PRIMARY KEY(restaurant_id,id)
);
CREATE INDEX marketing_consents_customer ON llenamos.marketing_consents(restaurant_id,customer_id,purpose,at DESC);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['customer_marketing','marketing_consents'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_access ON llenamos.%I USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id))',t);
    -- Los procedimientos SECURITY DEFINER (baja pública) los ven sin identidad de miembro.
    EXECUTE format('CREATE POLICY definer_custody ON llenamos.%I TO llenamos_migrator USING(true) WITH CHECK(true)',t);
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON llenamos.customer_marketing TO llenamos_app;
GRANT SELECT,INSERT ON llenamos.marketing_consents TO llenamos_app;

CREATE OR REPLACE FUNCTION llenamos.location_exists(rid text, lid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT EXISTS(SELECT 1 FROM llenamos.locations WHERE restaurant_id=rid AND id=lid)
$$;
ALTER FUNCTION llenamos.location_exists(text,text) OWNER TO llenamos_migrator;
REVOKE ALL ON FUNCTION llenamos.location_exists(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.location_exists(text,text) TO llenamos_app;

GRANT EXECUTE ON FUNCTION llenamos.actor_uid(), llenamos.is_platform(), llenamos.can_access_restaurant(text) TO llenamos_migrator;
CREATE POLICY migrator_locations ON llenamos.locations TO llenamos_migrator USING(true);
