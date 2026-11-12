-- Ejecutar con el rol bootstrap, nunca con el usuario runtime de la API.
DO $$ BEGIN
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='llenamos_migrator') THEN
    CREATE ROLE llenamos_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='llenamos_app') THEN
    CREATE ROLE llenamos_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS llenamos AUTHORIZATION llenamos_migrator;
REVOKE ALL ON SCHEMA llenamos FROM PUBLIC;
GRANT USAGE ON SCHEMA llenamos TO llenamos_app;

CREATE TABLE llenamos.identities (
  uid text PRIMARY KEY CHECK(length(uid) BETWEEN 1 AND 128),
  session_version text NOT NULL CHECK(session_version ~ '^[a-f0-9]{32}$'),
  tokens_valid_after timestamptz NOT NULL,
  locked boolean NOT NULL DEFAULT true,
  disabled boolean NOT NULL DEFAULT false,
  platform_operator boolean NOT NULL DEFAULT false
);
CREATE TABLE llenamos.restaurants (
  id varchar(128) PRIMARY KEY,
  name varchar(160) NOT NULL,
  slug varchar(128) NOT NULL UNIQUE,
  brand_color char(7) NOT NULL DEFAULT '#f0a35e' CHECK(brand_color ~ '^#[0-9a-fA-F]{6}$'),
  currency text NOT NULL DEFAULT 'EUR' CHECK(currency='EUR'),
  timezone text NOT NULL DEFAULT 'Europe/Madrid' CHECK(timezone='Europe/Madrid'),
  locale text NOT NULL DEFAULT 'es' CHECK(locale IN ('es','ca','en')),
  is_demo boolean NOT NULL DEFAULT false,
  plan text NOT NULL DEFAULT 'reservas' CHECK(plan IN ('reservas','sala','completo')),
  active_modules text[] NOT NULL DEFAULT '{}',
  module_overrides jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE llenamos.memberships (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  uid text NOT NULL REFERENCES llenamos.identities(uid),
  role text NOT NULL CHECK(role IN ('owner','manager','waiter','kitchen','bar')),
  active boolean NOT NULL DEFAULT false,
  display_name varchar(80) NOT NULL,
  email varchar(254) NOT NULL,
  location_ids text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY(restaurant_id,uid)
);
CREATE INDEX memberships_uid_active ON llenamos.memberships(uid,restaurant_id) WHERE active;
CREATE TABLE llenamos.locations (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(128) NOT NULL,
  name varchar(80) NOT NULL,
  slug varchar(128) NOT NULL,
  address varchar(200) NOT NULL DEFAULT '',
  city varchar(80) NOT NULL DEFAULT '',
  phone varchar(30) NOT NULL DEFAULT '',
  PRIMARY KEY(restaurant_id,id),
  UNIQUE(restaurant_id,slug)
);
CREATE TABLE llenamos.platform_restaurants (
  restaurant_id varchar(128) PRIMARY KEY REFERENCES llenamos.restaurants(id),
  name varchar(160) NOT NULL,
  slug varchar(128) NOT NULL UNIQUE,
  plan_id varchar(128) NOT NULL,
  owner_email varchar(254) NOT NULL,
  plan_version integer NOT NULL DEFAULT 1 CHECK(plan_version>0),
  status text NOT NULL DEFAULT 'trialing',
  active_modules text[] NOT NULL DEFAULT '{}',
  module_overrides jsonb NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE llenamos.outbox (
  id uuid PRIMARY KEY,
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  kind varchar(120) NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','done','failed','quarantined')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  lease_id uuid,
  lease_until timestamptz,
  UNIQUE(restaurant_id,id)
);
CREATE INDEX outbox_pending ON llenamos.outbox(restaurant_id,available_at,id) WHERE status IN ('pending','leased');
CREATE TABLE llenamos.jobs (
  id uuid PRIMARY KEY,
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  kind varchar(120) NOT NULL,
  deduplication_key varchar(256) NOT NULL,
  payload jsonb NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','done','failed','quarantined')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  lease_id uuid,
  lease_until timestamptz,
  UNIQUE(restaurant_id,kind,deduplication_key)
);
CREATE INDEX jobs_pending ON llenamos.jobs(restaurant_id,scheduled_at,id) WHERE status IN ('pending','leased');
CREATE TABLE llenamos.idempotency (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  actor_uid text NOT NULL,
  operation varchar(120) NOT NULL,
  request_key varchar(256) NOT NULL,
  request_hash char(64) NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,actor_uid,operation,request_key)
);

CREATE FUNCTION llenamos.actor_uid() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.actor_uid',true),'')
$$;
CREATE FUNCTION llenamos.is_platform() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.platform',true),'false')='true'
$$;
CREATE FUNCTION llenamos.can_access_restaurant(rid text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT llenamos.is_platform()
    AND rid=nullif(current_setting('app.restaurant_id',true),'')
    AND EXISTS(SELECT FROM llenamos.memberships m WHERE m.restaurant_id=rid AND m.uid=llenamos.actor_uid() AND m.active)
$$;
REVOKE ALL ON FUNCTION llenamos.actor_uid(), llenamos.is_platform(), llenamos.can_access_restaurant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.actor_uid(), llenamos.is_platform(), llenamos.can_access_restaurant(text) TO llenamos_app;

ALTER TABLE llenamos.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.identities FORCE ROW LEVEL SECURITY;
CREATE POLICY own_identity ON llenamos.identities FOR SELECT USING(uid=llenamos.actor_uid());
ALTER TABLE llenamos.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY own_membership ON llenamos.memberships FOR SELECT USING(uid=llenamos.actor_uid() AND NOT llenamos.is_platform());
ALTER TABLE llenamos.restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.restaurants FORCE ROW LEVEL SECURITY;
CREATE POLICY member_restaurant ON llenamos.restaurants FOR SELECT USING(NOT llenamos.is_platform()
  AND EXISTS(SELECT FROM llenamos.memberships m WHERE m.restaurant_id=id AND m.uid=llenamos.actor_uid() AND m.active));
ALTER TABLE llenamos.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.locations FORCE ROW LEVEL SECURITY;
CREATE POLICY member_location ON llenamos.locations FOR SELECT USING(llenamos.can_access_restaurant(restaurant_id)
  AND EXISTS(SELECT FROM llenamos.memberships m WHERE m.restaurant_id=locations.restaurant_id AND m.uid=llenamos.actor_uid()
    AND m.active AND (cardinality(m.location_ids)=0 OR locations.id=ANY(m.location_ids))));
ALTER TABLE llenamos.platform_restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.platform_restaurants FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_metadata ON llenamos.platform_restaurants FOR SELECT USING(llenamos.is_platform());

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['outbox','jobs'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_access ON llenamos.%I USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id))',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['identities','restaurants','memberships','locations','platform_restaurants','outbox','jobs','idempotency'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator',t);
  END LOOP;
END $$;
ALTER TABLE llenamos.idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY own_idempotency ON llenamos.idempotency
  USING(llenamos.can_access_restaurant(restaurant_id) AND actor_uid=llenamos.actor_uid())
  WITH CHECK(llenamos.can_access_restaurant(restaurant_id) AND actor_uid=llenamos.actor_uid());
-- No TRUNCATE, CREATE, BYPASSRLS ni mutación de identidades/permisos para el proceso HTTP.
GRANT SELECT ON llenamos.identities,llenamos.restaurants,llenamos.memberships,llenamos.locations,llenamos.platform_restaurants TO llenamos_app;
GRANT SELECT,INSERT,UPDATE ON llenamos.outbox,llenamos.jobs,llenamos.idempotency TO llenamos_app;
