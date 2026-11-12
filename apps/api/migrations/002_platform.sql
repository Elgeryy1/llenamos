-- Plataforma: mutaciones estrechas; el rol HTTP sigue sin escribir permisos/identidades.
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='llenamos_platform_writer') THEN
  CREATE ROLE llenamos_platform_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='llenamos_platform_writer' AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN RAISE EXCEPTION 'unsafe_platform_writer_role'; END IF;
END $$;
GRANT USAGE ON SCHEMA llenamos TO llenamos_platform_writer;
GRANT EXECUTE ON FUNCTION llenamos.actor_uid(),llenamos.is_platform() TO llenamos_platform_writer;
-- SELECT es necesario al planificar la política existente de restaurants; RLS mantiene
-- memberships vacío cuando app.platform=true, también dentro de estos procedimientos.
GRANT SELECT ON llenamos.identities,llenamos.memberships TO llenamos_platform_writer;
GRANT SELECT,INSERT,UPDATE ON llenamos.restaurants,llenamos.platform_restaurants TO llenamos_platform_writer;
GRANT INSERT ON llenamos.locations TO llenamos_platform_writer;

ALTER TABLE llenamos.restaurants ADD COLUMN entitlement_version integer;
ALTER TABLE llenamos.restaurants ADD COLUMN access_valid_until timestamptz;
ALTER TABLE llenamos.restaurants ADD COLUMN commercial_plan_id text;
ALTER TABLE llenamos.restaurants ADD COLUMN commercial_plan_version integer;
ALTER TABLE llenamos.platform_restaurants ADD COLUMN integration_status jsonb;

-- La expiración se comprueba con el reloj SQL aunque todavía no haya worker de proyección.
CREATE OR REPLACE FUNCTION llenamos.can_access_restaurant(rid text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT llenamos.is_platform()
  AND rid=nullif(current_setting('app.restaurant_id',true),'')
  AND EXISTS(SELECT FROM llenamos.memberships m WHERE m.restaurant_id=rid AND m.uid=llenamos.actor_uid() AND m.active)
  AND EXISTS(SELECT FROM llenamos.restaurants r WHERE r.id=rid AND (r.entitlement_version IS NULL OR r.access_valid_until>now()))
$$;

CREATE TABLE llenamos.platform_plans (
  id text NOT NULL, version integer NOT NULL CHECK(version>0), definition jsonb NOT NULL,
  PRIMARY KEY(id,version), CHECK(definition->>'id'=id AND (definition->>'version')::integer=version)
);
-- Catálogo provisional del contrato core; no activa Stripe ni cobros.
INSERT INTO llenamos.platform_plans SELECT p->>'id',1,p || '{"version":1,"provisional":true,"enabled":true,"trialDays":14,"currency":"EUR","stripeMonthlyPriceId":null,"stripeAnnualPriceId":null}'::jsonb
FROM jsonb_array_elements('[
 {"id":"barra","name":"Barra","legacyPlan":"reservas","modules":["reservations"],"monthlyCents":4900,"annualCents":46800,"limits":{"locations":1,"members":5,"apiKeys":0,"webhooks":0}},
 {"id":"sala","name":"Sala","legacyPlan":"sala","modules":["reservations","floor","kitchen"],"monthlyCents":9900,"annualCents":94800,"limits":{"locations":1,"members":15,"apiKeys":1,"webhooks":1}},
 {"id":"grupo","name":"Grupo","legacyPlan":"completo","modules":["reservations","floor","kitchen","pos"],"monthlyCents":19900,"annualCents":190800,"limits":{"locations":3,"members":50,"apiKeys":5,"webhooks":5}}
]'::jsonb) p;

CREATE TABLE llenamos.platform_subscriptions (
  restaurant_id varchar(128) PRIMARY KEY REFERENCES llenamos.restaurants(id),
  plan_id text NOT NULL, plan_version integer NOT NULL,
  status text NOT NULL CHECK(status IN ('not_configured','trialing','active','past_due','suspended','cancelled')),
  interval text NOT NULL DEFAULT 'month' CHECK(interval IN ('month','year')),
  trial_ends_at timestamptz, period_ends_at timestamptz, grace_ends_at timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  stripe_customer_id text, stripe_subscription_id text,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  FOREIGN KEY(plan_id,plan_version) REFERENCES llenamos.platform_plans(id,version)
);
CREATE TABLE llenamos.platform_usage (
  restaurant_id varchar(128) PRIMARY KEY REFERENCES llenamos.restaurants(id),
  locations integer NOT NULL CHECK(locations>=0), members integer NOT NULL CHECK(members>=0),
  api_keys integer NOT NULL CHECK(api_keys>=0), webhooks integer NOT NULL CHECK(webhooks>=0),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE llenamos.platform_requests (
  actor_uid text NOT NULL REFERENCES llenamos.identities(uid), operation text NOT NULL,
  request_key text NOT NULL CHECK(request_key ~ '^[A-Za-z0-9_-]{16,100}$'),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_uid,operation,request_key)
);
CREATE TABLE llenamos.integration_secrets (
  restaurant_id varchar(128) PRIMARY KEY REFERENCES llenamos.restaurants(id),
  ciphertext text NOT NULL CHECK(length(ciphertext) BETWEEN 40 AND 100000),
  key_version integer NOT NULL DEFAULT 1 CHECK(key_version=1), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE llenamos.platform_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_uid text NOT NULL,
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  action text NOT NULL, reason varchar(200), revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['platform_plans','platform_subscriptions','platform_usage','platform_requests','integration_secrets','platform_audit'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['platform_subscriptions','platform_usage','platform_requests','integration_secrets','platform_audit'] LOOP
    EXECUTE format('CREATE POLICY platform_writer ON llenamos.%I TO llenamos_platform_writer USING(llenamos.is_platform()) WITH CHECK(llenamos.is_platform())',t);
  END LOOP;
END $$;

-- Solo lo invocan procedimientos de invitación auditados; nunca el rol HTTP directamente.
CREATE POLICY invitation_usage ON llenamos.platform_usage TO llenamos_migrator USING(true) WITH CHECK(true);
CREATE POLICY invitation_subscription ON llenamos.platform_subscriptions FOR SELECT TO llenamos_migrator USING(true);
CREATE FUNCTION llenamos.invitation_member_capacity(p_rid text,p_delta integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE used integer; max_members integer; s llenamos.platform_subscriptions%ROWTYPE;
BEGIN
 IF p_delta NOT IN (-1,0,1) THEN RAISE EXCEPTION 'invalid_capacity_delta' USING ERRCODE='22023'; END IF;
 SELECT members INTO used FROM llenamos.platform_usage WHERE restaurant_id=p_rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'usage_missing' USING ERRCODE='P0001'; END IF;
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_missing' USING ERRCODE='P0001'; END IF;
 SELECT (definition->'limits'->>'members')::integer INTO max_members FROM llenamos.platform_plans WHERE id=s.plan_id AND version=s.plan_version;
 IF p_delta>0 AND NOT ((s.status='trialing' AND s.trial_ends_at>now()) OR (s.status='active' AND s.period_ends_at>now()) OR (s.status='past_due' AND s.grace_ends_at>now())) THEN RAISE EXCEPTION 'service_disabled' USING ERRCODE='P0001'; END IF;
 IF used+p_delta<0 OR (p_delta>0 AND max_members IS NOT NULL AND used+p_delta>max_members) THEN RAISE EXCEPTION 'member_capacity_exceeded' USING ERRCODE='P0001'; END IF;
 UPDATE llenamos.platform_usage SET members=members+p_delta,revision=revision+1 WHERE restaurant_id=p_rid;
END $$;
ALTER FUNCTION llenamos.invitation_member_capacity(text,integer) OWNER TO llenamos_migrator;
REVOKE ALL ON FUNCTION llenamos.invitation_member_capacity(text,integer) FROM PUBLIC;
CREATE POLICY public_plan_catalog ON llenamos.platform_plans FOR SELECT USING(true);
CREATE POLICY writer_restaurant ON llenamos.restaurants TO llenamos_platform_writer USING(llenamos.is_platform()) WITH CHECK(llenamos.is_platform());
CREATE POLICY writer_location ON llenamos.locations FOR INSERT TO llenamos_platform_writer WITH CHECK(llenamos.is_platform());
CREATE POLICY writer_metadata ON llenamos.platform_restaurants TO llenamos_platform_writer USING(llenamos.is_platform()) WITH CHECK(llenamos.is_platform());
GRANT SELECT ON llenamos.platform_plans TO llenamos_app,llenamos_platform_writer;
GRANT SELECT,INSERT,UPDATE ON llenamos.platform_subscriptions,llenamos.platform_usage,llenamos.platform_requests,llenamos.integration_secrets TO llenamos_platform_writer;
GRANT DELETE ON llenamos.integration_secrets TO llenamos_platform_writer;
GRANT INSERT ON llenamos.platform_audit TO llenamos_platform_writer;
GRANT USAGE ON SEQUENCE llenamos.platform_audit_id_seq TO llenamos_platform_writer;

CREATE FUNCTION llenamos.assert_platform_actor() RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,llenamos AS $$
BEGIN
 IF NOT llenamos.is_platform() OR NOT EXISTS(SELECT FROM llenamos.identities i WHERE i.uid=llenamos.actor_uid() AND i.platform_operator AND NOT i.disabled AND NOT i.locked) THEN
  RAISE EXCEPTION 'platform_forbidden' USING ERRCODE='42501';
 END IF;
END $$;

-- La reserva y el resultado comparten transacción con el alta. Advisory lock serializa reintentos.
CREATE FUNCTION llenamos.platform_request(p_operation text,p_key text,p_hash text,p_result jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE receipt llenamos.platform_requests%ROWTYPE;
BEGIN
 PERFORM llenamos.assert_platform_actor();
 IF p_operation NOT IN ('altaRestauranteLogiqd','configurarRestauranteLogiqd') THEN RAISE EXCEPTION 'invalid_operation' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(llenamos.actor_uid()||':'||p_operation||':'||p_key,0));
 SELECT * INTO receipt FROM llenamos.platform_requests WHERE actor_uid=llenamos.actor_uid() AND operation=p_operation AND request_key=p_key;
 IF FOUND AND receipt.request_hash<>p_hash THEN RAISE EXCEPTION 'request_conflict' USING ERRCODE='23505'; END IF;
 IF NOT FOUND THEN
  INSERT INTO llenamos.platform_requests(actor_uid,operation,request_key,request_hash) VALUES(llenamos.actor_uid(),p_operation,p_key,p_hash);
 END IF;
 IF p_result IS NOT NULL AND receipt.result IS NULL THEN
  UPDATE llenamos.platform_requests SET result=p_result WHERE actor_uid=llenamos.actor_uid() AND operation=p_operation AND request_key=p_key;
  RETURN p_result;
 END IF;
 RETURN receipt.result;
END $$;

CREATE FUNCTION llenamos.platform_create(p_rid text,p_name text,p_slug text,p_owner_email text,p_location_name text,p_location_slug text,p_plan_id text,p_plan_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE plan jsonb; deadline timestamptz; modules text[];
BEGIN
 PERFORM llenamos.assert_platform_actor();
 IF p_rid !~ '^rest_[a-f0-9]{32}$' OR length(p_name) NOT BETWEEN 2 AND 80 OR p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(p_slug)>60 OR length(p_location_name) NOT BETWEEN 2 AND 80 THEN RAISE EXCEPTION 'invalid_restaurant' USING ERRCODE='22023'; END IF;
 SELECT definition INTO plan FROM llenamos.platform_plans WHERE id=p_plan_id AND version=p_plan_version;
 IF plan IS NULL OR NOT (plan->>'enabled')::boolean THEN RAISE EXCEPTION 'plan_unavailable' USING ERRCODE='P0001'; END IF;
 IF coalesce((plan->'limits'->>'locations')::integer,1)<1 OR coalesce((plan->'limits'->>'members')::integer,1)<1 THEN RAISE EXCEPTION 'plan_capacity' USING ERRCODE='P0001'; END IF;
 deadline:=transaction_timestamp()+make_interval(days=>(plan->>'trialDays')::integer);
 modules:=ARRAY(SELECT jsonb_array_elements_text(plan->'modules'));
 IF deadline<=transaction_timestamp() THEN modules:='{}'; END IF;
 INSERT INTO llenamos.restaurants(id,name,slug,plan,active_modules,entitlement_version,access_valid_until,commercial_plan_id,commercial_plan_version)
 VALUES(p_rid,p_name,p_slug,plan->>'legacyPlan',modules,1,deadline,p_plan_id,p_plan_version);
 INSERT INTO llenamos.locations(restaurant_id,id,name,slug) VALUES(p_rid,'principal',p_location_name,p_location_slug);
 INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,owner_email,plan_id,plan_version,status,active_modules)
 VALUES(p_rid,p_name,p_slug,p_owner_email,p_plan_id,p_plan_version,'trialing',modules);
 INSERT INTO llenamos.platform_subscriptions(restaurant_id,plan_id,plan_version,status,trial_ends_at) VALUES(p_rid,p_plan_id,p_plan_version,'trialing',deadline);
 INSERT INTO llenamos.platform_usage(restaurant_id,locations,members,api_keys,webhooks) VALUES(p_rid,1,1,0,0);
 INSERT INTO llenamos.platform_audit(actor_uid,restaurant_id,action,revision) VALUES(llenamos.actor_uid(),p_rid,'restaurant.created',1);
 RETURN jsonb_build_object('restaurantId',p_rid,'locationId','principal');
END $$;

CREATE FUNCTION llenamos.platform_configuration(p_rid text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE; usage llenamos.platform_usage%ROWTYPE; ciphertext text;
BEGIN
 PERFORM llenamos.assert_platform_actor();
 PERFORM id FROM llenamos.restaurants WHERE id=p_rid FOR UPDATE;
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'restaurant_missing' USING ERRCODE='P0002'; END IF;
 SELECT * INTO usage FROM llenamos.platform_usage WHERE restaurant_id=p_rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'usage_missing' USING ERRCODE='P0001'; END IF;
 SELECT i.ciphertext INTO ciphertext FROM llenamos.integration_secrets i WHERE i.restaurant_id=p_rid;
 RETURN jsonb_build_object('subscription',to_jsonb(s),'usage',to_jsonb(usage),'ciphertext',ciphertext);
END $$;

CREATE FUNCTION llenamos.platform_configure(p_rid text,p_expected integer,p_subscription jsonb,p_modules text[],p_overrides jsonb,p_deadline timestamptz,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE; selected_plan jsonb; new_status text;
BEGIN
 PERFORM llenamos.assert_platform_actor();
 PERFORM id FROM llenamos.restaurants WHERE id=p_rid FOR UPDATE;
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'restaurant_missing' USING ERRCODE='P0002'; END IF;
 IF s.revision<>p_expected THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
 IF s.stripe_subscription_id IS NOT NULL THEN RAISE EXCEPTION 'stripe_contract_linked' USING ERRCODE='P0001'; END IF;
 new_status:=p_subscription->>'status';
 IF s.status='cancelled' AND new_status<>'cancelled' THEN RAISE EXCEPTION 'cancelled_final' USING ERRCODE='P0001'; END IF;
 SELECT definition INTO selected_plan FROM llenamos.platform_plans WHERE id=p_subscription->>'planId' AND version=(p_subscription->>'planVersion')::integer;
 IF selected_plan IS NULL OR NOT (selected_plan->>'enabled')::boolean THEN RAISE EXCEPTION 'plan_unavailable' USING ERRCODE='P0001'; END IF;
 UPDATE llenamos.platform_subscriptions SET plan_id=selected_plan->>'id',plan_version=(selected_plan->>'version')::integer,status=new_status,
  trial_ends_at=to_timestamp((p_subscription->>'trialEndsAt')::double precision/1000),period_ends_at=to_timestamp((p_subscription->>'periodEndsAt')::double precision/1000),
  grace_ends_at=to_timestamp((p_subscription->>'graceEndsAt')::double precision/1000),cancel_at_period_end=(p_subscription->>'cancelAtPeriodEnd')::boolean,revision=revision+1
 WHERE restaurant_id=p_rid;
 UPDATE llenamos.restaurants SET plan=selected_plan->>'legacyPlan',active_modules=p_modules,module_overrides=p_overrides,
  entitlement_version=p_expected+1,access_valid_until=p_deadline,commercial_plan_id=selected_plan->>'id',commercial_plan_version=(selected_plan->>'version')::integer WHERE id=p_rid;
 UPDATE llenamos.platform_restaurants SET plan_id=selected_plan->>'id',plan_version=(selected_plan->>'version')::integer,status=new_status,
  active_modules=p_modules,module_overrides=p_overrides,revision=p_expected+1 WHERE restaurant_id=p_rid;
 INSERT INTO llenamos.platform_audit(actor_uid,restaurant_id,action,reason,revision) VALUES(llenamos.actor_uid(),p_rid,'restaurant.configured',p_reason,p_expected+1);
END $$;

CREATE FUNCTION llenamos.platform_integrations(p_rid text,p_ciphertext text,p_status jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
 PERFORM llenamos.assert_platform_actor();
 IF NOT EXISTS(SELECT FROM llenamos.platform_restaurants WHERE restaurant_id=p_rid) THEN RAISE EXCEPTION 'restaurant_missing' USING ERRCODE='P0002'; END IF;
 IF p_ciphertext IS NULL THEN DELETE FROM llenamos.integration_secrets WHERE restaurant_id=p_rid;
 ELSE INSERT INTO llenamos.integration_secrets(restaurant_id,ciphertext) VALUES(p_rid,p_ciphertext)
 ON CONFLICT(restaurant_id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=now(); END IF;
 UPDATE llenamos.platform_restaurants SET integration_status=p_status WHERE restaurant_id=p_rid;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='llenamos' AND (p.proname LIKE 'platform\_%' ESCAPE '\' OR p.proname='assert_platform_actor') LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO llenamos_platform_writer',f);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  IF f::text NOT LIKE '%assert_platform_actor%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO llenamos_app',f); END IF;
 END LOOP;
END $$;
