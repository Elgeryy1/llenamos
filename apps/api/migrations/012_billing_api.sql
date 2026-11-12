-- Facturación (alta por su cuenta, prueba, cuotas de Stripe Billing) y API pública con claves,
-- eventos y webhooks salientes. Ejecutar con el rol bootstrap.
-- Todo lo que cruza restaurantes o escribe permisos pasa por funciones SECURITY DEFINER de
-- `llenamos_migrator` que comprueban al actor en SQL. FORCE RLS sigue activo en cada tabla.

ALTER TABLE llenamos.platform_subscriptions
  ADD COLUMN pending_intent text, ADD COLUMN last_billing_created bigint, ADD COLUMN last_paid_invoice_id text,
  ADD COLUMN renewal_grace boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX platform_subscriptions_stripe ON llenamos.platform_subscriptions(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- Políticas de custodia: solo las ejercen las funciones SECURITY DEFINER (el rol es NOLOGIN).
CREATE POLICY billing_custody ON llenamos.platform_subscriptions TO llenamos_migrator USING(true) WITH CHECK(true);
CREATE POLICY billing_custody_audit ON llenamos.platform_audit TO llenamos_migrator USING(true) WITH CHECK(true);
CREATE POLICY billing_custody_plans ON llenamos.platform_plans TO llenamos_migrator USING(true) WITH CHECK(true);
CREATE POLICY billing_custody_locations ON llenamos.locations FOR INSERT TO llenamos_migrator WITH CHECK(true);
CREATE POLICY billing_custody_locations_read ON llenamos.locations FOR SELECT TO llenamos_migrator USING(true);
CREATE POLICY billing_custody_events ON llenamos.events FOR INSERT TO llenamos_migrator WITH CHECK(true);
CREATE POLICY billing_custody_outbox ON llenamos.outbox TO llenamos_migrator USING(true) WITH CHECK(true);

-- Borradores del asistente de alta y recibos de sus comandos: propios de cada cuenta, sin restaurante todavía.
CREATE TABLE llenamos.platform_onboardings (
  id text PRIMARY KEY CHECK(id ~ '^[A-Za-z0-9_-]{1,128}$'),
  owner_uid text NOT NULL,
  restaurant_id varchar(128) REFERENCES llenamos.restaurants(id),
  status text NOT NULL CHECK(status IN ('draft','provisioning','ready','failed','cancelled')),
  step text NOT NULL CHECK(step IN ('identity','location','hours','plan','review','done')),
  revision integer NOT NULL CHECK(revision>0),
  request_id text NOT NULL,
  draft jsonb NOT NULL DEFAULT '{}',
  error varchar(300),
  trial_used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_onboardings_owner ON llenamos.platform_onboardings(owner_uid,created_at DESC);
CREATE TABLE llenamos.platform_self_requests (
  actor_uid text NOT NULL, operation text NOT NULL CHECK(operation IN ('guardarAlta','completarAlta')),
  request_key text NOT NULL CHECK(request_key ~ '^[A-Za-z0-9_-]{16,100}$'),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_uid,operation,request_key)
);
-- Una prueba gratis por cuenta, aunque cambie de borrador.
CREATE TABLE llenamos.platform_trials (
  owner_uid text PRIMARY KEY, restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  -- Buzón normalizado (sin +alias ni puntos de Gmail): otro uid con el mismo buzón no abre otra prueba.
  email_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Interruptores de plataforma que decide quien administra la base (no la API): `self_signup` abre el alta propia.
CREATE TABLE llenamos.platform_flags (name text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false);
-- Intenciones de Billing: la clave es el recibo de la petición y la correlación con Checkout.
CREATE TABLE llenamos.billing_intents (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id char(64) NOT NULL CHECK(id ~ '^[a-f0-9]{64}$'),
  actor_uid text NOT NULL, kind text NOT NULL CHECK(kind IN ('iniciarSuscripcion','abrirPortalFacturacion','cancelarSuscripcion')),
  fingerprint char(64) NOT NULL, plan_id text, plan_version integer, interval text,
  expected_revision integer, status text NOT NULL CHECK(status IN ('pending','ready')),
  result jsonb, external_id text, bound_subscription_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,id)
);
-- Eventos de Stripe Billing ya aplicados (la plataforma, no un restaurante, es la cuenta de Stripe).
CREATE TABLE llenamos.billing_events (
  event_hash char(64) PRIMARY KEY, event_id varchar(200) NOT NULL,
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  status text NOT NULL, created bigint NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);

-- API pública con claves.
CREATE TABLE llenamos.api_keys (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(128) NOT NULL, name varchar(80) NOT NULL, prefix varchar(16) NOT NULL,
  -- Solo el hash SHA-256: el token se muestra una vez y no se puede recuperar.
  token_hash char(64) NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] NOT NULL CHECK(cardinality(scopes) BETWEEN 1 AND 2 AND scopes <@ ARRAY['menu.read','orders.read']),
  location_ids text[] NOT NULL CHECK(cardinality(location_ids) BETWEEN 1 AND 100),
  expires_at timestamptz NOT NULL, revoked_at timestamptz, last_used_at timestamptz,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,id)
);
CREATE INDEX api_keys_list ON llenamos.api_keys(restaurant_id,created_at DESC,id DESC);
CREATE TABLE llenamos.api_rate (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  scope text NOT NULL, bucket bigint NOT NULL, count integer NOT NULL, PRIMARY KEY(restaurant_id,scope,bucket)
);
CREATE TABLE llenamos.webhook_endpoints (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(128) NOT NULL, url varchar(2000) NOT NULL CHECK(url ~ '^https://'),
  events text[] NOT NULL CHECK(cardinality(events)>=1),
  location_ids text[] NOT NULL CHECK(cardinality(location_ids) BETWEEN 1 AND 100),
  status text NOT NULL CHECK(status IN ('active','suspended','revoked')),
  secret_version integer NOT NULL CHECK(secret_version>=1), consecutive_failures integer NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,id)
);
CREATE INDEX webhook_endpoints_list ON llenamos.webhook_endpoints(restaurant_id,created_at DESC,id DESC);
CREATE TABLE llenamos.webhook_secrets (
  restaurant_id varchar(128) NOT NULL, endpoint_id varchar(128) NOT NULL, version integer NOT NULL CHECK(version>=1),
  ciphertext text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,endpoint_id,version), FOREIGN KEY(restaurant_id,endpoint_id) REFERENCES llenamos.webhook_endpoints(restaurant_id,id)
);
CREATE TABLE llenamos.webhook_deliveries (
  restaurant_id varchar(128) NOT NULL, id varchar(128) NOT NULL, endpoint_id varchar(128) NOT NULL,
  event_id varchar(128) NOT NULL, event jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','delivered','retry','exhausted','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 12), round integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_id uuid, lease_until timestamptz,
  last_status integer CHECK(last_status BETWEEN 100 AND 599), last_error varchar(300), last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,id), UNIQUE(restaurant_id,endpoint_id,event_id),
  FOREIGN KEY(restaurant_id,endpoint_id) REFERENCES llenamos.webhook_endpoints(restaurant_id,id)
);
CREATE INDEX webhook_deliveries_list ON llenamos.webhook_deliveries(restaurant_id,created_at DESC,id DESC);
CREATE INDEX webhook_deliveries_failed ON llenamos.webhook_deliveries(restaurant_id) WHERE status='exhausted';
CREATE TABLE llenamos.webhook_attempts (
  restaurant_id varchar(128) NOT NULL, delivery_id varchar(128) NOT NULL, round integer NOT NULL, attempt integer NOT NULL,
  status integer, duration_ms integer NOT NULL, error varchar(300), secret_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,delivery_id,round,attempt), FOREIGN KEY(restaurant_id,delivery_id) REFERENCES llenamos.webhook_deliveries(restaurant_id,id)
);
CREATE INDEX webhook_attempts_recent ON llenamos.webhook_attempts(restaurant_id,created_at DESC);
-- Rastro de las aperturas de soporte: no concede lectura del interior del restaurante.
CREATE TABLE llenamos.platform_support_access (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id), id varchar(128) NOT NULL,
  actor_uid text NOT NULL, reason varchar(200) NOT NULL, opened_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY(restaurant_id,id)
);

-- Acceso a claves y webhooks: la regla del contrato (`integraciones.gestionar`: propietario o encargado) en SQL.
CREATE FUNCTION llenamos.integration_access(rid text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT llenamos.can_access_restaurant(rid) AND (pg_has_role(current_user,'llenamos_worker','member')
  OR EXISTS(SELECT FROM llenamos.memberships m WHERE m.restaurant_id=rid AND m.uid=llenamos.actor_uid() AND m.active AND m.role IN ('owner','manager')))
$$;
REVOKE ALL ON FUNCTION llenamos.integration_access(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.integration_access(text) TO llenamos_app,llenamos_migrator;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['platform_onboardings','platform_self_requests','platform_trials','platform_flags','billing_intents','billing_events','api_keys','api_rate',
    'webhook_endpoints','webhook_secrets','webhook_deliveries','webhook_attempts','platform_support_access'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator',t);
  END LOOP;
  -- Claves y webhooks: solo propietario o encargado del restaurante con servicio vigente (o el worker de ese restaurante).
  FOREACH t IN ARRAY ARRAY['api_keys','webhook_endpoints','webhook_deliveries','webhook_attempts'] LOOP
    EXECUTE format('CREATE POLICY integration_access ON llenamos.%I USING(llenamos.integration_access(restaurant_id)) WITH CHECK(llenamos.integration_access(restaurant_id))',t);
  END LOOP;
  -- Los secretos de firma: quien gestiona los crea; solo el worker los lee para firmar.
  CREATE POLICY secret_insert ON llenamos.webhook_secrets FOR INSERT WITH CHECK(llenamos.integration_access(restaurant_id));
  CREATE POLICY secret_worker ON llenamos.webhook_secrets FOR SELECT USING(llenamos.can_access_restaurant(restaurant_id) AND pg_has_role(current_user,'llenamos_worker','member'));
  -- Solo funciones de custodia (suscripción vencida incluida) o el productor de eventos.
  FOREACH t IN ARRAY ARRAY['platform_onboardings','platform_self_requests','platform_trials','platform_flags','billing_intents','billing_events','api_keys','api_rate',
    'webhook_endpoints','webhook_secrets','webhook_deliveries','webhook_attempts','platform_support_access'] LOOP
    EXECUTE format('CREATE POLICY billing_custody ON llenamos.%I TO llenamos_migrator USING(true) WITH CHECK(true)',t);
  END LOOP;
END $$;
CREATE POLICY own_onboarding ON llenamos.platform_onboardings USING(owner_uid=llenamos.actor_uid() AND NOT llenamos.is_platform())
  WITH CHECK(owner_uid=llenamos.actor_uid() AND NOT llenamos.is_platform());
CREATE POLICY own_self_request ON llenamos.platform_self_requests USING(actor_uid=llenamos.actor_uid() AND NOT llenamos.is_platform())
  WITH CHECK(actor_uid=llenamos.actor_uid() AND NOT llenamos.is_platform());

-- GRANT mínimos. Las claves y entregas solo cambian las columnas que el servicio necesita.
GRANT SELECT,INSERT,UPDATE ON llenamos.platform_onboardings,llenamos.platform_self_requests TO llenamos_app;
-- El hash de la clave no se lee con SQL de la API: solo `api_key_authenticate` lo compara.
GRANT INSERT ON llenamos.api_keys TO llenamos_app;
GRANT SELECT(restaurant_id,id,name,prefix,scopes,location_ids,expires_at,revoked_at,last_used_at,created_by,created_at) ON llenamos.api_keys TO llenamos_app;
GRANT UPDATE(revoked_at) ON llenamos.api_keys TO llenamos_app;
GRANT SELECT,INSERT ON llenamos.webhook_endpoints,llenamos.webhook_secrets,llenamos.webhook_deliveries,llenamos.webhook_attempts TO llenamos_app;
GRANT SELECT ON llenamos.platform_flags TO llenamos_migrator;
GRANT UPDATE(url,events,location_ids,status,secret_version,consecutive_failures,updated_at) ON llenamos.webhook_endpoints TO llenamos_app;
GRANT UPDATE(status,attempts,round,next_attempt_at,lease_id,lease_until,last_status,last_error,last_attempt_at) ON llenamos.webhook_deliveries TO llenamos_app;

GRANT EXECUTE ON FUNCTION llenamos.can_access_restaurant(text) TO llenamos_migrator;

-- Ayudantes internos (no se conceden a llenamos_app).
CREATE FUNCTION llenamos.billing_member(p_rid text,p_owner boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE r text;
BEGIN
 IF llenamos.is_platform() OR llenamos.actor_uid() IS NULL THEN RAISE EXCEPTION 'billing_forbidden' USING ERRCODE='42501'; END IF;
 SELECT m.role INTO r FROM llenamos.memberships m JOIN llenamos.identities i ON i.uid=m.uid
  WHERE m.restaurant_id=p_rid AND m.uid=llenamos.actor_uid() AND m.active AND NOT i.locked AND NOT i.disabled AND NOT i.platform_operator;
 IF r IS NULL OR r NOT IN ('owner','manager') OR (p_owner AND r<>'owner') THEN RAISE EXCEPTION 'billing_forbidden' USING ERRCODE='42501'; END IF;
 RETURN r;
END $$;
CREATE FUNCTION llenamos.billing_operator() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
 IF NOT llenamos.is_platform() OR NOT EXISTS(SELECT FROM llenamos.identities i WHERE i.uid=llenamos.actor_uid() AND i.platform_operator AND NOT i.disabled AND NOT i.locked) THEN
  RAISE EXCEPTION 'billing_forbidden' USING ERRCODE='42501';
 END IF;
END $$;

-- Evento de plataforma: una entrega por webhook activo suscrito y su trabajo en la cola, en la misma transacción
-- del hecho. SECURITY DEFINER para que funcione también en flujos públicos (reserva sin miembro, worker), pero
-- solo para el restaurante del contexto de la transacción: nunca fabrica eventos de otro.
CREATE FUNCTION llenamos.platform_emit_event(p_rid text,p_id text,p_type text,p_location text,p_entity text,p_status text,p_occurred bigint DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE n integer;
BEGIN
 IF p_type NOT IN ('reservation.created','reservation.statusChanged','order.placed','orderLine.statusChanged','payment.succeeded','subscription.changed','privacy.completed') THEN
  RAISE EXCEPTION 'invalid_event' USING ERRCODE='22023';
 END IF;
 IF p_rid IS NULL OR p_rid NOT IN (coalesce(nullif(current_setting('app.restaurant_id',true),''),'-'),coalesce(nullif(current_setting('app.public_restaurant',true),''),'-'),coalesce(nullif(current_setting('app.billing_restaurant',true),''),'-')) THEN
  RAISE EXCEPTION 'event_context' USING ERRCODE='42501';
 END IF;
 WITH ev AS (SELECT jsonb_build_object('id',p_id,'type',p_type,'version',1,'restaurantId',p_rid,'locationId',p_location,
    'occurredAt',coalesce(p_occurred,(extract(epoch FROM clock_timestamp())*1000)::bigint),'data',jsonb_build_object('entityId',p_entity,'status',p_status)) AS e),
  ep AS (SELECT w.id FROM llenamos.webhook_endpoints w WHERE w.restaurant_id=p_rid AND w.status='active' AND p_type=ANY(w.events)
    AND ((p_location IS NOT NULL AND p_location=ANY(w.location_ids)) OR (p_location IS NULL AND p_type='subscription.changed')) ORDER BY w.id LIMIT 100),
  ins AS (INSERT INTO llenamos.webhook_deliveries(restaurant_id,id,endpoint_id,event_id,event)
    SELECT p_rid,'d_'||left(encode(sha256(convert_to(ep.id||':'||p_id,'UTF8')),'hex'),40),ep.id,p_id,ev.e FROM ep,ev
    ON CONFLICT(restaurant_id,endpoint_id,event_id) DO NOTHING RETURNING id),
  q AS (INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload)
    SELECT (substr(h,1,8)||'-'||substr(h,9,4)||'-'||substr(h,13,4)||'-'||substr(h,17,4)||'-'||substr(h,21,12))::uuid,p_rid,'plataforma.entrega',
     jsonb_build_object('deliveryId',ins.id,'round',0,'attempt',0)
    FROM (SELECT ins.id,encode(sha256(convert_to('entrega:'||ins.id||':0:0','UTF8')),'hex') AS h FROM ins) ins
    ON CONFLICT(id) DO NOTHING RETURNING 1)
 SELECT count(*) INTO n FROM q;
 RETURN n;
END $$;

-- Aviso interno de cambio de suscripción: tiempo real, auditoría y webhooks. Solo desde otras funciones.
CREATE FUNCTION llenamos.billing_publish(p_rid text,p_change text,p_actor text,p_action text,p_status text,p_revision integer,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
 INSERT INTO llenamos.platform_audit(actor_uid,restaurant_id,action,reason,revision) VALUES(p_actor,p_rid,p_action,left(p_reason,200),p_revision);
 INSERT INTO llenamos.events(restaurant_id,topic,entity_id,payload) VALUES(p_rid,'plataforma.suscripcion','subscription',jsonb_build_object('status',p_status,'revision',p_revision));
 -- Las funciones de Billing actúan sin sesión de restaurante: fijan el suyo para el aviso.
 PERFORM set_config('app.billing_restaurant',p_rid,true);
 PERFORM llenamos.platform_emit_event(p_rid,p_change,'subscription.changed',NULL,'subscription',p_status);
 PERFORM set_config('app.billing_restaurant','',true);
END $$;

-- Vencimiento (prueba, gracia o periodo): suspende o da de baja, cierra módulos y avisa. Idempotente.
CREATE FUNCTION llenamos.billing_expire(p_rid text) RETURNS llenamos.platform_subscriptions
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE; allowed boolean;
BEGIN
 PERFORM id FROM llenamos.restaurants WHERE id=p_rid FOR UPDATE;
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_missing' USING ERRCODE='P0001'; END IF;
 allowed:=(s.status='trialing' AND s.trial_ends_at>now()) OR (s.status='past_due' AND s.grace_ends_at>now()) OR (s.status='active' AND s.period_ends_at>now());
 IF NOT allowed AND s.status='active' AND s.stripe_subscription_id IS NOT NULL AND NOT s.cancel_at_period_end THEN
  -- Contrato de pago vigente que renueva: Stripe cobra la factura de la renovación pasado un rato. Mientras tanto no se
  -- corta el servicio: pasa a impago con un margen de 48 h; la factura pagada lo devuelve a activo.
  UPDATE llenamos.platform_subscriptions SET status='past_due',grace_ends_at=now()+interval '48 hours',renewal_grace=true,revision=revision+1
   WHERE restaurant_id=p_rid RETURNING * INTO s;
  UPDATE llenamos.restaurants SET entitlement_version=s.revision,access_valid_until=s.grace_ends_at WHERE id=p_rid;
  UPDATE llenamos.platform_restaurants SET status=s.status,revision=s.revision WHERE restaurant_id=p_rid;
  PERFORM llenamos.billing_publish(p_rid,'expiry_'||p_rid||'_'||s.revision,'system:expiry','subscription.renewal_grace',s.status,s.revision,NULL);
 ELSIF NOT allowed AND s.status IN ('trialing','active','past_due') THEN
  UPDATE llenamos.platform_subscriptions SET status=CASE WHEN cancel_at_period_end THEN 'cancelled' ELSE 'suspended' END,revision=revision+1
   WHERE restaurant_id=p_rid RETURNING * INTO s;
  UPDATE llenamos.restaurants SET entitlement_version=s.revision,active_modules='{}',access_valid_until=least(access_valid_until,now()) WHERE id=p_rid;
  UPDATE llenamos.platform_restaurants SET status=s.status,active_modules='{}',revision=s.revision WHERE restaurant_id=p_rid;
  PERFORM llenamos.billing_publish(p_rid,'expiry_'||p_rid||'_'||s.revision,'system:expiry','subscription.expired',s.status,s.revision,NULL);
 END IF;
 RETURN s;
END $$;
-- Barrido para el worker de mantenimiento: aplica los vencimientos ya cumplidos sin esperar a que alguien mire el plan.
CREATE FUNCTION llenamos.billing_expire_due(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE rid text; n integer:=0;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_limit' USING ERRCODE='22023'; END IF;
 FOR rid IN SELECT restaurant_id FROM llenamos.platform_subscriptions
  WHERE (status='trialing' AND trial_ends_at<=now()) OR (status='past_due' AND grace_ends_at<=now()) OR (status='active' AND period_ends_at<=now())
  ORDER BY restaurant_id LIMIT p_limit LOOP
  PERFORM llenamos.billing_expire(rid);n:=n+1;
 END LOOP;
 RETURN n;
END $$;

-- Lectura de la suscripción. Aplica en SQL el vencimiento la primera vez que se mira.
CREATE FUNCTION llenamos.billing_view(p_rid text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE; r llenamos.restaurants%ROWTYPE; pdef jsonb;
BEGIN
 PERFORM llenamos.billing_member(p_rid,false);
 s:=llenamos.billing_expire(p_rid);
 SELECT * INTO r FROM llenamos.restaurants WHERE id=p_rid;
 IF r.entitlement_version IS NULL THEN RAISE EXCEPTION 'subscription_missing' USING ERRCODE='P0001'; END IF;
 SELECT definition INTO pdef FROM llenamos.platform_plans WHERE id=s.plan_id AND version=s.plan_version;
 RETURN jsonb_build_object('subscription',to_jsonb(s),'overrides',r.module_overrides,'plan',pdef);
END $$;

-- Intención pendiente de Checkout vigente: una sesión sin completar caduca a las 24 h y deja de bloquear otros cambios.
CREATE FUNCTION llenamos.billing_pending_intent(p_rid text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
 SELECT s.pending_intent FROM llenamos.platform_subscriptions s JOIN llenamos.billing_intents i ON i.restaurant_id=s.restaurant_id AND i.id=s.pending_intent
  WHERE s.restaurant_id=p_rid AND i.created_at>now()-interval '24 hours'
$$;

-- Contexto de una acción de facturación del propietario: suscripción, uso e intención previa. Sin bloqueos.
CREATE FUNCTION llenamos.billing_context(p_rid text,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE; u llenamos.platform_usage%ROWTYPE; i llenamos.billing_intents%ROWTYPE;
BEGIN
 PERFORM llenamos.billing_member(p_rid,true);
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_missing' USING ERRCODE='P0001'; END IF;
 SELECT * INTO u FROM llenamos.platform_usage WHERE restaurant_id=p_rid;
 SELECT * INTO i FROM llenamos.billing_intents WHERE restaurant_id=p_rid AND id=p_key;
 RETURN jsonb_build_object('subscription',to_jsonb(s),'pending',llenamos.billing_pending_intent(p_rid),'usage',CASE WHEN u.restaurant_id IS NULL THEN NULL ELSE to_jsonb(u) END,'intent',CASE WHEN i.id IS NULL THEN NULL ELSE to_jsonb(i) END);
END $$;

-- Guarda la intención y su respuesta. Repetir el mismo comando devuelve la respuesta guardada.
CREATE FUNCTION llenamos.billing_intent_commit(p_rid text,p_key text,p_kind text,p_fingerprint text,p_plan_id text,p_plan_version integer,p_interval text,
  p_expected integer,p_result jsonb,p_external text,p_pending boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE; i llenamos.billing_intents%ROWTYPE;
BEGIN
 PERFORM llenamos.billing_member(p_rid,true);
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_missing' USING ERRCODE='P0001'; END IF;
 SELECT * INTO i FROM llenamos.billing_intents WHERE restaurant_id=p_rid AND id=p_key FOR UPDATE;
 IF FOUND THEN
  IF i.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'request_conflict' USING ERRCODE='23505'; END IF;
  IF i.result IS NOT NULL THEN RETURN i.result; END IF;
 ELSIF p_expected IS NOT NULL AND p_expected<>s.revision THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';
 END IF;
 IF p_kind<>'abrirPortalFacturacion' AND llenamos.billing_pending_intent(p_rid) IS NOT NULL AND llenamos.billing_pending_intent(p_rid)<>p_key AND p_pending THEN RAISE EXCEPTION 'billing_pending' USING ERRCODE='P0001'; END IF;
 INSERT INTO llenamos.billing_intents(restaurant_id,id,actor_uid,kind,fingerprint,plan_id,plan_version,interval,expected_revision,status,result,external_id)
 VALUES(p_rid,p_key,llenamos.actor_uid(),p_kind,p_fingerprint,p_plan_id,p_plan_version,p_interval,s.revision,'ready',p_result,p_external)
 ON CONFLICT(restaurant_id,id) DO UPDATE SET status='ready',result=excluded.result,external_id=excluded.external_id,updated_at=now();
 IF p_pending THEN UPDATE llenamos.platform_subscriptions SET pending_intent=p_key WHERE restaurant_id=p_rid; END IF;
 RETURN p_result;
END $$;

-- La baja programada solo se confirma si Stripe declara el mismo fin de periodo que conocemos.
CREATE FUNCTION llenamos.billing_cancel_commit(p_rid text,p_key text,p_fingerprint text,p_expected integer,p_ends_ms bigint,p_result jsonb,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE; i llenamos.billing_intents%ROWTYPE;
BEGIN
 PERFORM llenamos.billing_member(p_rid,true);
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_missing' USING ERRCODE='P0001'; END IF;
 SELECT * INTO i FROM llenamos.billing_intents WHERE restaurant_id=p_rid AND id=p_key FOR UPDATE;
 IF FOUND THEN
  IF i.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'request_conflict' USING ERRCODE='23505'; END IF;
  IF i.result IS NOT NULL THEN RETURN i.result; END IF;
 ELSIF p_expected<>s.revision THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';
 END IF;
 IF s.period_ends_at IS NULL OR (extract(epoch FROM s.period_ends_at)*1000)::bigint<>p_ends_ms THEN RAISE EXCEPTION 'period_changed' USING ERRCODE='P0001'; END IF;
 UPDATE llenamos.platform_subscriptions SET cancel_at_period_end=true,revision=revision+1,pending_intent=NULL WHERE restaurant_id=p_rid RETURNING * INTO s;
 UPDATE llenamos.restaurants SET entitlement_version=s.revision WHERE id=p_rid;
 UPDATE llenamos.platform_restaurants SET revision=s.revision WHERE restaurant_id=p_rid;
 INSERT INTO llenamos.billing_intents(restaurant_id,id,actor_uid,kind,fingerprint,expected_revision,status,result)
 VALUES(p_rid,p_key,llenamos.actor_uid(),'cancelarSuscripcion',p_fingerprint,p_expected,'ready',p_result)
 ON CONFLICT(restaurant_id,id) DO UPDATE SET status='ready',result=excluded.result,updated_at=now();
 PERFORM llenamos.billing_publish(p_rid,'cancel_'||p_key,llenamos.actor_uid(),'subscription.cancel_at_period_end',s.status,s.revision,p_reason);
 RETURN p_result;
END $$;

-- Eventos de Stripe Billing ---------------------------------------------------------------------
-- Sin actor humano: el llamador (el receptor con firma verificada) es la única ruta a estas funciones.
CREATE FUNCTION llenamos.billing_event_seen(p_hash text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
 SELECT EXISTS(SELECT FROM llenamos.billing_events WHERE event_hash=p_hash AND status<>'blocked_overage')
$$;
CREATE FUNCTION llenamos.billing_event_peek(p_subscription text,p_customer text,p_hash text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
 SELECT jsonb_build_object('restaurantId',restaurant_id,'lastBillingCreated',coalesce(last_billing_created,-1),
  'blocked',EXISTS(SELECT FROM llenamos.billing_events e WHERE e.event_hash=p_hash AND e.status='blocked_overage'))
 FROM llenamos.platform_subscriptions WHERE stripe_subscription_id=p_subscription AND stripe_customer_id=p_customer
$$;
CREATE FUNCTION llenamos.billing_event_bind(p_hash text,p_event text,p_created bigint,p_rid text,p_intent text,p_checkout text,p_customer text,p_subscription text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE; i llenamos.billing_intents%ROWTYPE;
BEGIN
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'checkout_mismatch' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT FROM llenamos.billing_events WHERE event_hash=p_hash) THEN RETURN 'duplicate'; END IF;
 SELECT * INTO i FROM llenamos.billing_intents WHERE restaurant_id=p_rid AND id=p_intent FOR UPDATE;
 IF NOT FOUND OR i.kind<>'iniciarSuscripcion' OR i.external_id IS DISTINCT FROM p_checkout OR s.pending_intent IS DISTINCT FROM p_intent THEN RAISE EXCEPTION 'checkout_mismatch' USING ERRCODE='P0001'; END IF;
 IF (s.stripe_customer_id IS NOT NULL AND s.stripe_customer_id<>p_customer) OR (s.stripe_subscription_id IS NOT NULL AND s.stripe_subscription_id<>p_subscription) THEN
  RAISE EXCEPTION 'checkout_mismatch' USING ERRCODE='P0001';
 END IF;
 -- Vincular ids no concede servicio ni convierte la prueba en un pago.
 UPDATE llenamos.platform_subscriptions SET stripe_customer_id=p_customer,stripe_subscription_id=p_subscription WHERE restaurant_id=p_rid;
 UPDATE llenamos.billing_intents SET bound_subscription_id=p_subscription,updated_at=now() WHERE restaurant_id=p_rid AND id=p_intent;
 INSERT INTO llenamos.billing_events(event_hash,event_id,restaurant_id,status,created) VALUES(p_hash,p_event,p_rid,'bound',p_created);
 RETURN 'bound';
END $$;
-- Una sesión de Checkout abandonada deja de bloquear otros cambios de facturación.
CREATE FUNCTION llenamos.billing_event_checkout_expired(p_hash text,p_event text,p_created bigint,p_rid text,p_intent text,p_checkout text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE;
BEGIN
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'checkout_mismatch' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT FROM llenamos.billing_events WHERE event_hash=p_hash) THEN RETURN 'duplicate'; END IF;
 IF NOT EXISTS(SELECT FROM llenamos.billing_intents WHERE restaurant_id=p_rid AND id=p_intent AND kind='iniciarSuscripcion' AND external_id=p_checkout) THEN RAISE EXCEPTION 'checkout_mismatch' USING ERRCODE='P0001'; END IF;
 UPDATE llenamos.platform_subscriptions SET pending_intent=NULL WHERE restaurant_id=p_rid AND pending_intent=p_intent;
 INSERT INTO llenamos.billing_events(event_hash,event_id,restaurant_id,status,created) VALUES(p_hash,p_event,p_rid,'checkout_expired',p_created);
 RETURN 'checkout_expired';
END $$;
-- Bloquea el contrato y devuelve lo necesario para decidir fuera de SQL: el catálogo viaja dentro (el receptor no lee tablas).
CREATE FUNCTION llenamos.billing_event_lock(p_subscription text,p_customer text,p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE; r llenamos.restaurants%ROWTYPE; u llenamos.platform_usage%ROWTYPE;
BEGIN
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE stripe_subscription_id=p_subscription AND stripe_customer_id=p_customer FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'contract_unbound' USING ERRCODE='P0001'; END IF;
 SELECT * INTO r FROM llenamos.restaurants WHERE id=s.restaurant_id;
 SELECT * INTO u FROM llenamos.platform_usage WHERE restaurant_id=s.restaurant_id;
 RETURN jsonb_build_object('restaurantId',s.restaurant_id,'seen',EXISTS(SELECT FROM llenamos.billing_events WHERE event_hash=p_hash AND status<>'blocked_overage'),
  'plans',(SELECT coalesce(jsonb_agg(definition),'[]') FROM (SELECT definition FROM llenamos.platform_plans ORDER BY id,version LIMIT 500) d),
  'subscription',to_jsonb(s),'overrides',r.module_overrides,'usage',CASE WHEN u.restaurant_id IS NULL THEN NULL ELSE to_jsonb(u) END);
END $$;
CREATE FUNCTION llenamos.billing_event_commit(p_hash text,p_event text,p_created bigint,p_rid text,p_status_applied text,p_observed bigint,p_subscription jsonb,
  p_modules text[],p_overrides jsonb,p_deadline timestamptz,p_paid_invoice text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE; pdef jsonb;
BEGIN
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'contract_unbound' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT FROM llenamos.billing_events WHERE event_hash=p_hash AND status<>'blocked_overage') THEN RETURN 'duplicate'; END IF;
 IF coalesce(s.last_billing_created,-1)<>p_observed THEN RAISE EXCEPTION 'event_reordered' USING ERRCODE='40001'; END IF;
 SELECT definition INTO pdef FROM llenamos.platform_plans WHERE id=p_subscription->>'planId' AND version=(p_subscription->>'planVersion')::integer;
 IF pdef IS NULL THEN RAISE EXCEPTION 'plan_unavailable' USING ERRCODE='P0001'; END IF;
 UPDATE llenamos.platform_subscriptions SET plan_id=p_subscription->>'planId',plan_version=(p_subscription->>'planVersion')::integer,status=p_subscription->>'status',
  interval=p_subscription->>'interval',period_ends_at=to_timestamp((p_subscription->>'periodEndsAt')::double precision/1000),
  grace_ends_at=to_timestamp((p_subscription->>'graceEndsAt')::double precision/1000),cancel_at_period_end=(p_subscription->>'cancelAtPeriodEnd')::boolean,
  revision=s.revision+1,pending_intent=NULL,last_billing_created=greatest(p_created,coalesce(s.last_billing_created,-1)),
  last_paid_invoice_id=coalesce(p_paid_invoice,s.last_paid_invoice_id),renewal_grace=coalesce((p_subscription->>'renewalGrace')::boolean,false)
  WHERE restaurant_id=p_rid RETURNING * INTO s;
 UPDATE llenamos.restaurants SET plan=pdef->>'legacyPlan',active_modules=p_modules,module_overrides=p_overrides,entitlement_version=s.revision,
  access_valid_until=p_deadline,commercial_plan_id=s.plan_id,commercial_plan_version=s.plan_version WHERE id=p_rid;
 UPDATE llenamos.platform_restaurants SET plan_id=s.plan_id,plan_version=s.plan_version,status=s.status,active_modules=p_modules,module_overrides=p_overrides,revision=s.revision WHERE restaurant_id=p_rid;
 -- Una factura pagada que no cabe en los límites del plan (`blocked_overage`) puede reaplicarse al reenviar el evento.
 INSERT INTO llenamos.billing_events(event_hash,event_id,restaurant_id,status,created) VALUES(p_hash,p_event,p_rid,p_status_applied,p_created)
  ON CONFLICT(event_hash) DO UPDATE SET status=excluded.status,received_at=now();
 PERFORM llenamos.billing_publish(p_rid,'billing_'||p_hash||'_'||s.revision,'system:stripe-billing','subscription.billing_event',s.status,s.revision,NULL);
 RETURN p_status_applied;
END $$;

-- Catálogo y excepciones (equipo de plataforma) -----------------------------------------------------
CREATE FUNCTION llenamos.billing_plan_publish(p_plan jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE old jsonb;
BEGIN
 PERFORM llenamos.billing_operator();
 SELECT definition INTO old FROM llenamos.platform_plans WHERE id=p_plan->>'id' AND version=(p_plan->>'version')::integer FOR UPDATE;
 IF old IS NOT NULL THEN
  IF old<>p_plan THEN RAISE EXCEPTION 'plan_immutable' USING ERRCODE='P0001'; END IF;
  RETURN;
 END IF;
 -- Un precio de Stripe identifica una sola versión del catálogo: si no, las renovaciones de ese precio serían ambiguas.
 IF (p_plan->>'stripeMonthlyPriceId') IS NOT NULL AND p_plan->>'stripeMonthlyPriceId'=p_plan->>'stripeAnnualPriceId' THEN RAISE EXCEPTION 'price_reused' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT FROM llenamos.platform_plans o WHERE (o.id,o.version)<>(p_plan->>'id',(p_plan->>'version')::integer)
   AND ((p_plan->>'stripeMonthlyPriceId') IN (o.definition->>'stripeMonthlyPriceId',o.definition->>'stripeAnnualPriceId')
     OR (p_plan->>'stripeAnnualPriceId') IN (o.definition->>'stripeMonthlyPriceId',o.definition->>'stripeAnnualPriceId'))) THEN
  RAISE EXCEPTION 'price_reused' USING ERRCODE='P0001';
 END IF;
 INSERT INTO llenamos.platform_plans(id,version,definition) VALUES(p_plan->>'id',(p_plan->>'version')::integer,p_plan);
END $$;
CREATE FUNCTION llenamos.billing_overrides_read(p_rid text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE; r llenamos.restaurants%ROWTYPE; plan jsonb;
BEGIN
 PERFORM llenamos.billing_operator();
 SELECT * INTO r FROM llenamos.restaurants WHERE id=p_rid FOR UPDATE;
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'restaurant_missing' USING ERRCODE='P0002'; END IF;
 IF r.entitlement_version IS NULL THEN RAISE EXCEPTION 'subscription_missing' USING ERRCODE='P0001'; END IF;
 SELECT definition INTO plan FROM llenamos.platform_plans WHERE id=s.plan_id AND version=s.plan_version;
 RETURN jsonb_build_object('subscription',to_jsonb(s),'plan',plan);
END $$;
CREATE FUNCTION llenamos.billing_overrides_commit(p_rid text,p_expected integer,p_overrides jsonb,p_modules text[],p_deadline timestamptz,p_reason text,p_change text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE;
BEGIN
 PERFORM llenamos.billing_operator();
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'restaurant_missing' USING ERRCODE='P0002'; END IF;
 IF s.revision<>p_expected THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
 UPDATE llenamos.platform_subscriptions SET revision=revision+1 WHERE restaurant_id=p_rid RETURNING * INTO s;
 UPDATE llenamos.restaurants SET module_overrides=p_overrides,active_modules=p_modules,entitlement_version=s.revision,access_valid_until=p_deadline WHERE id=p_rid;
 UPDATE llenamos.platform_restaurants SET module_overrides=p_overrides,active_modules=p_modules,revision=s.revision WHERE restaurant_id=p_rid;
 PERFORM llenamos.billing_publish(p_rid,p_change,llenamos.actor_uid(),'subscription.overrides',s.status,s.revision,p_reason);
END $$;
CREATE FUNCTION llenamos.billing_support_open(p_rid text,p_id text,p_reason text,p_minutes integer) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE valid_until timestamptz;
BEGIN
 PERFORM llenamos.billing_operator();
 IF p_minutes NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'invalid_duration' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT FROM llenamos.platform_restaurants WHERE restaurant_id=p_rid) THEN RAISE EXCEPTION 'restaurant_missing' USING ERRCODE='P0002'; END IF;
 valid_until:=now()+make_interval(mins=>p_minutes);
 INSERT INTO llenamos.platform_support_access(restaurant_id,id,actor_uid,reason,expires_at) VALUES(p_rid,p_id,llenamos.actor_uid(),left(p_reason,200),valid_until);
 INSERT INTO llenamos.platform_audit(actor_uid,restaurant_id,action,reason,revision)
  VALUES(llenamos.actor_uid(),p_rid,'support.opened',left(p_reason,200),(SELECT revision FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid));
 RETURN valid_until;
END $$;

-- Medición real de uso: un restaurante (propietario o encargado) o un tramo para el equipo de plataforma.
CREATE FUNCTION llenamos.billing_usage(p_rid text,p_after text,p_limit integer,p_status text) RETURNS TABLE(
  restaurant_id varchar,name varchar,plan_id text,status text,locations bigint,members bigint,api_keys bigint,webhooks bigint,failed_deliveries bigint,
  active_modules text[],module_overrides jsonb,legacy_plan text,revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
 IF p_rid IS NOT NULL THEN PERFORM llenamos.billing_member(p_rid,false); ELSE PERFORM llenamos.billing_operator(); END IF;
 IF p_limit NOT BETWEEN 1 AND 101 THEN RAISE EXCEPTION 'invalid_limit' USING ERRCODE='22023'; END IF;
 RETURN QUERY SELECT r.id,r.name,coalesce(s.plan_id,r.plan),coalesce(s.status,'not_configured'),
   (SELECT count(*) FROM llenamos.locations l WHERE l.restaurant_id=r.id),
   (SELECT count(*) FROM llenamos.memberships m WHERE m.restaurant_id=r.id AND m.active),
   (SELECT count(*) FROM llenamos.api_keys k WHERE k.restaurant_id=r.id AND k.revoked_at IS NULL AND k.expires_at>now()),
   (SELECT count(*) FROM llenamos.webhook_endpoints w WHERE w.restaurant_id=r.id AND w.status<>'revoked'),
   (SELECT count(*) FROM llenamos.webhook_deliveries d WHERE d.restaurant_id=r.id AND d.status='exhausted'),
   r.active_modules,r.module_overrides,r.plan,r.entitlement_version
  FROM llenamos.restaurants r LEFT JOIN llenamos.platform_subscriptions s ON s.restaurant_id=r.id
  WHERE (p_rid IS NULL OR r.id=p_rid) AND (p_after IS NULL OR r.id>p_after) AND (p_status IS NULL OR coalesce(s.status,'not_configured')=p_status)
  ORDER BY r.id LIMIT p_limit;
END $$;

-- Reserva de cuota de claves y webhooks con el contador autoritativo (recuento real, no el guardado).
CREATE FUNCTION llenamos.billing_capacity(p_rid text,p_resource text,p_reserve boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE s llenamos.platform_subscriptions%ROWTYPE; keys integer; hooks integer; lim integer;
BEGIN
 IF p_resource NOT IN ('apiKeys','webhooks') THEN RAISE EXCEPTION 'invalid_resource' USING ERRCODE='22023'; END IF;
 IF NOT llenamos.can_access_restaurant(p_rid) THEN RAISE EXCEPTION 'billing_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM llenamos.billing_member(p_rid,false);
 PERFORM id FROM llenamos.restaurants WHERE id=p_rid FOR UPDATE;
 SELECT * INTO s FROM llenamos.platform_subscriptions WHERE restaurant_id=p_rid;
 IF NOT FOUND THEN RAISE EXCEPTION 'subscription_missing' USING ERRCODE='P0001'; END IF;
 PERFORM 1 FROM llenamos.platform_usage WHERE restaurant_id=p_rid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'usage_missing' USING ERRCODE='P0001'; END IF;
 SELECT count(*) INTO keys FROM llenamos.api_keys WHERE restaurant_id=p_rid AND revoked_at IS NULL AND expires_at>now();
 SELECT count(*) INTO hooks FROM llenamos.webhook_endpoints WHERE restaurant_id=p_rid AND status<>'revoked';
 SELECT (definition->'limits'->>p_resource)::integer INTO lim FROM llenamos.platform_plans WHERE id=s.plan_id AND version=s.plan_version;
 IF p_reserve AND lim IS NOT NULL AND (CASE WHEN p_resource='apiKeys' THEN keys ELSE hooks END)+1>lim THEN RAISE EXCEPTION 'capacity_exceeded' USING ERRCODE='P0001'; END IF;
 UPDATE llenamos.platform_usage SET api_keys=keys+CASE WHEN p_reserve AND p_resource='apiKeys' THEN 1 ELSE 0 END,
  webhooks=hooks+CASE WHEN p_reserve AND p_resource='webhooks' THEN 1 ELSE 0 END,revision=revision+1 WHERE restaurant_id=p_rid;
END $$;

-- Autenticación de una clave de la API pública (sin sesión): valida, limita y registra el uso en una sola llamada.
CREATE FUNCTION llenamos.api_key_authenticate(p_hash text,p_rid text,p_location text,p_scope text,p_key_limit integer,p_restaurant_limit integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE k llenamos.api_keys%ROWTYPE; r llenamos.restaurants%ROWTYPE; minute bigint:=floor(extract(epoch FROM now())/60); a integer; b integer;
BEGIN
 SELECT * INTO k FROM llenamos.api_keys WHERE token_hash=p_hash AND restaurant_id=p_rid;
 IF NOT FOUND OR k.revoked_at IS NOT NULL OR k.expires_at<=now() THEN RAISE EXCEPTION 'api_key_invalid' USING ERRCODE='P0001'; END IF;
 SELECT * INTO r FROM llenamos.restaurants WHERE id=p_rid;
 IF NOT (p_scope=ANY(k.scopes) AND p_location=ANY(k.location_ids)) OR NOT EXISTS(SELECT FROM llenamos.locations WHERE restaurant_id=p_rid AND id=p_location) THEN RAISE EXCEPTION 'api_key_scope' USING ERRCODE='P0001'; END IF;
 IF NOT ('floor'=ANY(r.active_modules)) THEN RAISE EXCEPTION 'api_key_module' USING ERRCODE='P0001'; END IF;
 IF r.entitlement_version IS NOT NULL AND (r.access_valid_until IS NULL OR r.access_valid_until<=now()) THEN RAISE EXCEPTION 'api_key_service' USING ERRCODE='P0001'; END IF;
 DELETE FROM llenamos.api_rate WHERE restaurant_id=p_rid AND bucket<minute-5;
 INSERT INTO llenamos.api_rate(restaurant_id,scope,bucket,count) VALUES(p_rid,'k:'||k.id,minute,1)
  ON CONFLICT(restaurant_id,scope,bucket) DO UPDATE SET count=api_rate.count+1 RETURNING count INTO a;
 INSERT INTO llenamos.api_rate(restaurant_id,scope,bucket,count) VALUES(p_rid,'restaurant',minute,1)
  ON CONFLICT(restaurant_id,scope,bucket) DO UPDATE SET count=api_rate.count+1 RETURNING count INTO b;
 IF a>p_key_limit OR b>p_restaurant_limit THEN RAISE EXCEPTION 'api_rate' USING ERRCODE='P0001'; END IF;
 UPDATE llenamos.api_keys SET last_used_at=now() WHERE restaurant_id=p_rid AND id=k.id;
 RETURN k.id;
END $$;

-- Alta por su cuenta: crea restaurante, local, propietario, suscripción de prueba y uso en una transacción.
CREATE FUNCTION llenamos.billing_onboarding_complete(p_onboarding text,p_expected integer,p_rid text,p_location_slug text,p_request text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE o llenamos.platform_onboardings%ROWTYPE; plan jsonb; d jsonb; deadline timestamptz; modules text[]; m llenamos.memberships%ROWTYPE; s llenamos.platform_subscriptions%ROWTYPE;
 actor text:=llenamos.actor_uid(); mail text; mail_local text; mail_domain text;
BEGIN
 IF llenamos.is_platform() OR actor IS NULL OR NOT EXISTS(SELECT FROM llenamos.identities i WHERE i.uid=actor AND NOT i.locked AND NOT i.disabled AND NOT i.platform_operator) THEN
  RAISE EXCEPTION 'billing_forbidden' USING ERRCODE='42501';
 END IF;
 -- El alta propia es una decisión de quien administra la base, no solo de la configuración de la API.
 IF NOT coalesce((SELECT enabled FROM llenamos.platform_flags WHERE name='self_signup'),false) THEN RAISE EXCEPTION 'self_signup_disabled' USING ERRCODE='42501'; END IF;
 IF p_rid !~ '^alta_[a-f0-9]{32}$' THEN RAISE EXCEPTION 'invalid_restaurant' USING ERRCODE='22023'; END IF;
 SELECT * INTO o FROM llenamos.platform_onboardings WHERE id=p_onboarding AND owner_uid=actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'onboarding_missing' USING ERRCODE='P0002'; END IF;
 IF o.revision<>p_expected OR o.status NOT IN ('draft','failed') THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
 d:=o.draft;
 IF length(btrim(coalesce(d->>'name',''))) NOT BETWEEN 2 AND 80 OR coalesce(d->>'slug','') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(d->>'slug')>60 OR length(btrim(coalesce(d->'location'->>'name',''))) NOT BETWEEN 2 AND 80 OR p_location_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
  RAISE EXCEPTION 'invalid_restaurant' USING ERRCODE='22023';
 END IF;
 SELECT definition INTO plan FROM llenamos.platform_plans WHERE id=d->>'planId' AND version=(d->>'planVersion')::integer;
 IF plan IS NULL OR NOT (plan->>'enabled')::boolean THEN RAISE EXCEPTION 'plan_unavailable' USING ERRCODE='P0001'; END IF;
 IF coalesce((plan->'limits'->>'locations')::integer,1)<1 OR coalesce((plan->'limits'->>'members')::integer,1)<1 THEN RAISE EXCEPTION 'plan_capacity' USING ERRCODE='P0001'; END IF;
 -- El correo y el nombre son los de una membresía que esta cuenta ya tiene (acreditada por invitación aceptada).
 SELECT * INTO m FROM llenamos.memberships WHERE uid=actor ORDER BY active DESC,restaurant_id LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'owner_email_unknown' USING ERRCODE='P0001'; END IF;
 deadline:=transaction_timestamp()+make_interval(days=>(plan->>'trialDays')::integer);
 modules:=ARRAY(SELECT jsonb_array_elements_text(plan->'modules'));
 IF deadline<=transaction_timestamp() THEN modules:='{}'; END IF;
 INSERT INTO llenamos.restaurants(id,name,slug,plan,active_modules,entitlement_version,access_valid_until,commercial_plan_id,commercial_plan_version)
  VALUES(p_rid,d->>'name',d->>'slug',plan->>'legacyPlan',modules,1,deadline,plan->>'id',(plan->>'version')::integer);
 mail:=lower(m.email);mail_local:=split_part(split_part(mail,'@',1),'+',1);mail_domain:=split_part(mail,'@',2);
 IF mail_domain IN ('gmail.com','googlemail.com') THEN mail_local:=replace(mail_local,'.','');mail_domain:='gmail.com'; END IF;
 INSERT INTO llenamos.platform_trials(owner_uid,restaurant_id,email_key) VALUES(actor,p_rid,mail_local||'@'||mail_domain) ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'trial_used' USING ERRCODE='P0001'; END IF;
 INSERT INTO llenamos.locations(restaurant_id,id,name,slug,address,city,phone)
  VALUES(p_rid,'principal',d->'location'->>'name',p_location_slug,d->'location'->>'address',d->'location'->>'city',d->'location'->>'phone');
 INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email,location_ids) VALUES(p_rid,actor,'owner',true,m.display_name,m.email,'{}');
 INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,owner_email,plan_id,plan_version,status,active_modules)
  VALUES(p_rid,d->>'name',d->>'slug',m.email,plan->>'id',(plan->>'version')::integer,'trialing',modules);
 INSERT INTO llenamos.platform_subscriptions(restaurant_id,plan_id,plan_version,status,trial_ends_at) VALUES(p_rid,plan->>'id',(plan->>'version')::integer,'trialing',deadline) RETURNING * INTO s;
 INSERT INTO llenamos.platform_usage(restaurant_id,locations,members,api_keys,webhooks) VALUES(p_rid,1,1,0,0);
 UPDATE llenamos.platform_onboardings SET status='ready',step='done',restaurant_id=p_rid,trial_used=true,revision=revision+1,request_id=p_request,error=NULL,updated_at=now() WHERE id=p_onboarding;
 PERFORM llenamos.billing_publish(p_rid,'onboarding_'||p_onboarding,actor,'restaurant.self_created',s.status,s.revision,NULL);
 RETURN jsonb_build_object('restaurantId',p_rid,'locationId','principal','subscription',to_jsonb(s),'plan',plan,'overrides','{}'::jsonb);
END $$;

-- Entregas de webhook atascadas (worker caído tras reclamar, trabajo perdido o en cuarentena): se vuelve a encolar el
-- siguiente intento con un ID nuevo por hora. Para el mantenimiento del worker; no mira datos de personas.
CREATE FUNCTION llenamos.billing_deliveries_sweep(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE n integer;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_limit' USING ERRCODE='22023'; END IF;
 WITH stuck AS (
  SELECT d.restaurant_id,d.id,d.round,d.attempts,d.status FROM llenamos.webhook_deliveries d
  WHERE ((d.status='leased' AND d.lease_until<now()-interval '5 minutes') OR (d.status IN ('queued','retry') AND d.next_attempt_at<now()-interval '30 minutes'))
   AND NOT EXISTS(SELECT FROM llenamos.outbox o WHERE o.restaurant_id=d.restaurant_id AND o.kind='plataforma.entrega' AND o.status IN ('pending','leased') AND o.payload->>'deliveryId'=d.id)
  ORDER BY d.next_attempt_at LIMIT p_limit),
 q AS (INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload)
  SELECT (substr(h,1,8)||'-'||substr(h,9,4)||'-'||substr(h,13,4)||'-'||substr(h,17,4)||'-'||substr(h,21,12))::uuid,x.restaurant_id,'plataforma.entrega',
   jsonb_build_object('deliveryId',x.id,'round',x.round,'attempt',CASE WHEN x.status='leased' THEN greatest(x.attempts-1,0) ELSE x.attempts END)
  FROM (SELECT stuck.*,encode(sha256(convert_to('barrido:'||stuck.id||':'||stuck.round||':'||stuck.attempts||':'||floor(extract(epoch FROM now())/3600),'UTF8')),'hex') AS h FROM stuck) x
  ON CONFLICT(id) DO NOTHING RETURNING 1)
 SELECT count(*) INTO n FROM q;
 RETURN n;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='llenamos' AND (p.proname LIKE 'billing\_%' ESCAPE '\' OR p.proname='api_key_authenticate' OR p.proname='platform_emit_event') LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO llenamos_migrator',f);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  IF f::text LIKE 'llenamos.billing_event\_%' ESCAPE '\' THEN
   -- Receptor de Billing: su propio login, que no es miembro de llenamos_app.
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO llenamos_webhook',f);
  ELSIF f::text LIKE 'llenamos.billing_expire_due(%' OR f::text LIKE 'llenamos.billing_deliveries_sweep(%' THEN
   -- Mantenimiento: solo el worker.
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO llenamos_worker',f);
  ELSIF f::text NOT LIKE 'llenamos.billing_member(%' AND f::text NOT LIKE 'llenamos.billing_operator(%' AND f::text NOT LIKE 'llenamos.billing_publish(%' AND f::text NOT LIKE 'llenamos.billing_expire(%' AND f::text NOT LIKE 'llenamos.billing_pending_intent(%' THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO llenamos_app',f);
  END IF;
 END LOOP;
END $$;
-- platform_request ya existía: se amplía la lista de comandos del equipo de plataforma con recibos propios.
CREATE OR REPLACE FUNCTION llenamos.platform_request(p_operation text,p_key text,p_hash text,p_result jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE receipt llenamos.platform_requests%ROWTYPE;
BEGIN
 PERFORM llenamos.assert_platform_actor();
 IF p_operation NOT IN ('altaRestauranteLogiqd','configurarRestauranteLogiqd','guardarPlanPlataforma','cambiarExcepcionesPlataforma','abrirAccesoSoporte') THEN RAISE EXCEPTION 'invalid_operation' USING ERRCODE='22023'; END IF;
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
