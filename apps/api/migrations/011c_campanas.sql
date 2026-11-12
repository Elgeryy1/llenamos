-- Campañas con permiso, baja pública y origen de las reservas (V7, subagente B).
-- Usa customer_marketing y marketing_consents de 011_clientes_base.sql. No envía nada: el envío es del worker por outbox.

CREATE TABLE llenamos.marketing_settings (
  restaurant_id varchar(128) PRIMARY KEY REFERENCES llenamos.restaurants(id),
  settings jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llenamos.marketing_segments (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(128) NOT NULL,
  name varchar(80) NOT NULL,
  rule jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,id)
);
CREATE INDEX marketing_segments_list ON llenamos.marketing_segments(restaurant_id,created_at DESC,id);

CREATE TABLE llenamos.marketing_campaigns (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(128) NOT NULL,
  name varchar(80) NOT NULL,
  segment_id varchar(128) NOT NULL,
  channel text NOT NULL CHECK(channel IN ('email','whatsapp')),
  content jsonb NOT NULL,
  location_id varchar(128),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','sending','sent','cancelled')),
  scheduled_at timestamptz,
  launched_by text,
  -- Regla del segmento congelada al lanzar: la audiencia no cambia si luego se edita el segmento.
  rule_snapshot jsonb,
  stat_audience integer NOT NULL DEFAULT 0 CHECK(stat_audience>=0),
  stat_queued integer NOT NULL DEFAULT 0 CHECK(stat_queued>=0),
  stat_excluded integer NOT NULL DEFAULT 0 CHECK(stat_excluded>=0),
  stat_sent integer NOT NULL DEFAULT 0 CHECK(stat_sent>=0),
  stat_failed integer NOT NULL DEFAULT 0 CHECK(stat_failed>=0),
  stat_cancelled integer NOT NULL DEFAULT 0 CHECK(stat_cancelled>=0),
  cursor char(20),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,id)
);
CREATE INDEX marketing_campaigns_list ON llenamos.marketing_campaigns(restaurant_id,created_at DESC,id);
CREATE INDEX marketing_campaigns_due ON llenamos.marketing_campaigns(restaurant_id,scheduled_at,id) WHERE status IN ('scheduled','sending');
CREATE INDEX marketing_campaigns_segment ON llenamos.marketing_campaigns(restaurant_id,segment_id) WHERE status IN ('draft','scheduled','sending');

-- Por qué entró o no cada cliente en una campaña. Sin contacto: solo el hash del contacto para detectar repetidos.
CREATE TABLE llenamos.marketing_campaign_recipients (
  restaurant_id varchar(128) NOT NULL,
  campaign_id varchar(128) NOT NULL,
  customer_id char(20) NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','excluded','sent','failed','cancelled','not_configured')),
  excluded_reason text CHECK(excluded_reason IN ('no_contact','no_consent','withdrawn','suppressed','frequency','duplicate_contact')),
  message_id uuid,
  contact_hash char(64),
  at timestamptz NOT NULL,
  PRIMARY KEY(restaurant_id,campaign_id,customer_id),
  FOREIGN KEY(restaurant_id,campaign_id) REFERENCES llenamos.marketing_campaigns(restaurant_id,id),
  CHECK((status='excluded')=(excluded_reason IS NOT NULL))
);
CREATE INDEX marketing_recipients_status ON llenamos.marketing_campaign_recipients(restaurant_id,campaign_id,status);
CREATE INDEX marketing_recipients_contact ON llenamos.marketing_campaign_recipients(restaurant_id,campaign_id,contact_hash) WHERE contact_hash IS NOT NULL;

-- Mensajes de marketing por cliente de los últimos 30 días (se poda al escribir y nunca se lee más allá).
CREATE TABLE llenamos.marketing_send_log (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  customer_id char(20) NOT NULL,
  campaign_id varchar(128) NOT NULL,
  at timestamptz NOT NULL,
  PRIMARY KEY(restaurant_id,customer_id,campaign_id)
);
CREATE INDEX marketing_send_log_recent ON llenamos.marketing_send_log(restaurant_id,customer_id,at DESC);

-- Tokens de baja: solo el hash sha256 del token (el token va en el enlace del mensaje).
CREATE TABLE llenamos.marketing_unsubscribe_tokens (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  token_hash char(64) NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  customer_id char(20) NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('marketing_email','marketing_whatsapp')),
  message_id uuid NOT NULL,
  campaign_id varchar(128),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,token_hash)
);
CREATE INDEX marketing_unsubscribe_campaign ON llenamos.marketing_unsubscribe_tokens(restaurant_id,campaign_id) WHERE used_at IS NOT NULL;

-- Contadores de la baja pública sin identidad (solo los ve el procedimiento SECURITY DEFINER).
CREATE TABLE llenamos.marketing_unsubscribe_limits (
  bucket varchar(300) NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY(bucket,window_start)
);
CREATE INDEX marketing_unsubscribe_limits_old ON llenamos.marketing_unsubscribe_limits(window_start);

-- Origen de cada reserva (sin datos personales). Lo escribe la creación de la reserva (V3) con recordReservationOrigin.
CREATE TABLE IF NOT EXISTS llenamos.reservation_origins (
  restaurant_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  reservation_id varchar(128) NOT NULL,
  channel text NOT NULL,
  paid boolean NOT NULL DEFAULT false,
  source varchar(100), medium varchar(100), campaign varchar(100), content varchar(100), term varchar(100),
  ad_id varchar(100),
  campaign_id varchar(64),
  click_ids text[] NOT NULL DEFAULT '{}',
  referrer_host varchar(253),
  embed_host varchar(253),
  reservation_source varchar(40) NOT NULL,
  service_date date NOT NULL,
  party_size integer NOT NULL CHECK(party_size>=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  final_status text NOT NULL DEFAULT 'pending' CHECK(final_status IN ('pending','confirmed','seated','finished','cancelled','no_show')),
  sales_cents bigint NOT NULL DEFAULT 0 CHECK(sales_cents>=0),
  PRIMARY KEY(restaurant_id,reservation_id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE INDEX IF NOT EXISTS reservation_origins_date ON llenamos.reservation_origins(restaurant_id,location_id,service_date);
CREATE INDEX IF NOT EXISTS reservation_origins_campaign ON llenamos.reservation_origins(restaurant_id,campaign_id) WHERE campaign_id IS NOT NULL;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['marketing_settings','marketing_segments','marketing_campaigns','marketing_campaign_recipients','marketing_send_log','marketing_unsubscribe_tokens'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_access ON llenamos.%I USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id))',t);
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator',t);
  END LOOP;
  -- Solo los procedimientos SECURITY DEFINER (baja pública, retirada de permiso) ven estas tablas sin identidad de miembro.
  FOREACH t IN ARRAY ARRAY['marketing_campaigns','marketing_campaign_recipients','marketing_unsubscribe_tokens'] LOOP
    EXECUTE format('CREATE POLICY definer_custody ON llenamos.%I TO llenamos_migrator USING(true) WITH CHECK(true)',t);
  END LOOP;
END $$;
ALTER TABLE llenamos.marketing_unsubscribe_limits OWNER TO llenamos_migrator;
ALTER TABLE llenamos.marketing_unsubscribe_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.marketing_unsubscribe_limits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON llenamos.marketing_unsubscribe_limits FROM PUBLIC,llenamos_app;
CREATE POLICY definer_custody ON llenamos.marketing_unsubscribe_limits TO llenamos_migrator USING(true) WITH CHECK(true);

-- El procedimiento de retirada borra mensajes de campaña aún no enviados y registra el evento de baja.
CREATE POLICY marketing_custody ON llenamos.outbox FOR ALL TO llenamos_migrator USING(kind='marketing.campaign_message') WITH CHECK(false);
CREATE POLICY marketing_events ON llenamos.events FOR INSERT TO llenamos_migrator WITH CHECK(topic='campanas.baja');
-- Índices para cancelar por cliente o por campaña sin recorrer toda la cola.
CREATE INDEX outbox_marketing_customer ON llenamos.outbox(restaurant_id,(payload->>'customerId')) WHERE kind='marketing.campaign_message';
CREATE INDEX outbox_marketing_campaign ON llenamos.outbox(restaurant_id,(payload->>'campaignId')) WHERE kind='marketing.campaign_message';

GRANT SELECT,INSERT,UPDATE ON llenamos.marketing_settings,llenamos.marketing_campaigns,llenamos.marketing_campaign_recipients,llenamos.reservation_origins TO llenamos_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON llenamos.marketing_segments TO llenamos_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON llenamos.marketing_send_log TO llenamos_app;
GRANT EXECUTE ON FUNCTION llenamos.actor_uid(), llenamos.is_platform(), llenamos.can_access_restaurant(text) TO llenamos_migrator;
GRANT SELECT,INSERT ON llenamos.marketing_unsubscribe_tokens TO llenamos_app;

-- Cancela mensajes de campaña pendientes (interno: lo llaman el disparador, la baja y la cancelación).
-- Un mensaje ya reclamado por el worker no se toca: el worker revalida el permiso antes de enviar.
CREATE FUNCTION llenamos.marketing_cancel_pending(rid text,p_customer text,p_purpose text,p_campaign text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE n integer;
BEGIN
  WITH gone AS (
    DELETE FROM llenamos.outbox o
    WHERE o.restaurant_id=rid AND o.kind='marketing.campaign_message' AND o.status IN ('pending','failed')
      AND (p_customer IS NULL OR o.payload->>'customerId'=p_customer)
      AND (p_purpose IS NULL OR o.payload->>'purpose'=p_purpose)
      AND (p_campaign IS NULL OR o.payload->>'campaignId'=p_campaign)
    RETURNING o.payload->>'campaignId' AS campaign_id,o.payload->>'customerId' AS customer_id
  ), upd AS (
    UPDATE llenamos.marketing_campaign_recipients r SET status='cancelled'
    FROM gone WHERE r.restaurant_id=rid AND r.campaign_id=gone.campaign_id AND r.customer_id=gone.customer_id AND r.status='queued'
    RETURNING r.campaign_id
  ), per AS (SELECT campaign_id,count(*)::integer AS n FROM upd GROUP BY campaign_id),
  stats AS (
    UPDATE llenamos.marketing_campaigns c SET stat_cancelled=c.stat_cancelled+per.n,stat_queued=greatest(c.stat_queued-per.n,0),updated_at=now()
    FROM per WHERE c.restaurant_id=rid AND c.id=per.campaign_id RETURNING 1
  )
  SELECT coalesce((SELECT sum(per.n) FROM per),0)::integer INTO n;
  RETURN n;
END $$;

-- Cancelación de una campaña por quien opera: comprueba el acceso al restaurante antes de usar el interno.
CREATE FUNCTION llenamos.marketing_cancel_campaign(rid text,p_campaign text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
  IF NOT llenamos.can_access_restaurant(rid) THEN RAISE EXCEPTION 'marketing_denied'; END IF;
  RETURN llenamos.marketing_cancel_pending(rid,NULL,NULL,p_campaign);
END $$;

-- Al retirar un permiso (baja pública, personal o importación) se cancelan los mensajes pendientes de ese cliente y propósito.
CREATE FUNCTION llenamos.marketing_on_withdrawn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
  PERFORM llenamos.marketing_cancel_pending(NEW.restaurant_id,NEW.customer_id::text,NEW.purpose,NULL);
  RETURN NULL;
END $$;
CREATE TRIGGER marketing_consent_withdrawn AFTER INSERT ON llenamos.marketing_consents
  FOR EACH ROW WHEN (NEW.status='withdrawn') EXECUTE FUNCTION llenamos.marketing_on_withdrawn();

-- Baja pública. Resuelve el restaurante por slug y consume el token por hash. Devuelve 'ok' o 'limited'
-- (no lanza error: el contador debe quedar confirmado). Misma respuesta exista o no el slug o el token.
CREATE FUNCTION llenamos.marketing_unsubscribe(p_slug text,p_hash text,p_now timestamptz,p_window_seconds integer,p_slug_limit integer,p_token_limit integer,p_unknown_limit integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE v_rid text; v_win timestamptz; v_hits integer; v_tok llenamos.marketing_unsubscribe_tokens; v_bucket text;
BEGIN
  IF p_hash !~ '^[a-f0-9]{64}$' OR length(p_slug)>128 OR p_window_seconds NOT BETWEEN 1 AND 86400
     OR p_slug_limit NOT BETWEEN 1 AND 100000 OR p_token_limit NOT BETWEEN 1 AND 1000 OR p_unknown_limit NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'marketing_invalid'; END IF;
  v_win:=to_timestamp(floor(extract(epoch FROM p_now)/p_window_seconds)*p_window_seconds);
  -- Poda acotada de ventanas viejas para que la tabla no crezca con tokens falsos.
  DELETE FROM llenamos.marketing_unsubscribe_limits WHERE ctid IN (
    SELECT l.ctid FROM llenamos.marketing_unsubscribe_limits l WHERE l.window_start<v_win-(p_window_seconds*3)*interval '1 second' LIMIT 500);
  SELECT r.id INTO v_rid FROM llenamos.restaurants r WHERE r.slug=p_slug;
  -- Un slug inexistente comparte un único contador: un atacante no puede crear filas con slugs al azar.
  v_bucket:=CASE WHEN v_rid IS NULL THEN 'unknown' ELSE 'slug:'||v_rid END;
  INSERT INTO llenamos.marketing_unsubscribe_limits AS l(bucket,window_start,hits) VALUES(v_bucket,v_win,1)
    ON CONFLICT ON CONSTRAINT marketing_unsubscribe_limits_pkey DO UPDATE SET hits=l.hits+1 RETURNING l.hits INTO v_hits;
  IF v_hits>(CASE WHEN v_rid IS NULL THEN p_unknown_limit ELSE p_slug_limit END) THEN RETURN 'limited'; END IF;
  IF v_rid IS NULL THEN RETURN 'ok'; END IF;
  INSERT INTO llenamos.marketing_unsubscribe_limits AS l(bucket,window_start,hits) VALUES('token:'||v_rid||':'||p_hash,v_win,1)
    ON CONFLICT ON CONSTRAINT marketing_unsubscribe_limits_pkey DO UPDATE SET hits=l.hits+1 RETURNING l.hits INTO v_hits;
  IF v_hits>p_token_limit THEN RETURN 'limited'; END IF;
  SELECT * INTO v_tok FROM llenamos.marketing_unsubscribe_tokens t WHERE t.restaurant_id=v_rid AND t.token_hash=p_hash FOR UPDATE;
  IF v_tok.token_hash IS NULL OR v_tok.used_at IS NOT NULL OR v_tok.expires_at<=p_now THEN RETURN 'ok'; END IF;
  -- El disparador de marketing_consents cancela los mensajes pendientes de ese cliente y propósito.
  INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id)
    VALUES(v_rid,'unsubscribe.'||p_hash,v_tok.customer_id,v_tok.purpose,'withdrawn','unsubscribe',p_now,'public',v_tok.message_id::text) ON CONFLICT DO NOTHING;
  UPDATE llenamos.marketing_unsubscribe_tokens t SET used_at=p_now WHERE t.restaurant_id=v_rid AND t.token_hash=p_hash;
  INSERT INTO llenamos.events(restaurant_id,topic,entity_id,payload) VALUES(v_rid,'campanas.baja',v_tok.campaign_id,jsonb_build_object('purpose',v_tok.purpose));
  RETURN 'ok';
END $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='llenamos' AND p.proname LIKE 'marketing_%' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO llenamos_migrator',f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    IF f::text LIKE '%marketing_unsubscribe(%' OR f::text LIKE '%marketing_cancel_campaign(%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO llenamos_app',f); END IF;
  END LOOP;
END $$;
