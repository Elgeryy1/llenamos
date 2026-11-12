-- Worker, avisos, webhooks, archivos privados y privacidad. Ejecutar con el rol bootstrap.
-- El worker es un proceso aparte: su login pertenece a `llenamos_app` y a `llenamos_worker`; la API
-- no puede pertenecer a `llenamos_worker`. Las funciones SECURITY DEFINER de `llenamos_worker_fn`
-- son la única vía de lectura entre restaurantes (reclamar trabajos, abrir credenciales).
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['llenamos_worker','llenamos_worker_fn','llenamos_webhook'] LOOP
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',r);
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
    END;
  END LOOP;
END $$;
-- `llenamos_webhook` es el login del receptor de webhooks: NO es miembro de `llenamos_app` y solo puede
-- ejecutar `webhook_signing_secret` y `webhook_accept`. Una inyección SQL en el resto de la API no puede
-- anotar eventos ni leer secretos de firma.
GRANT USAGE ON SCHEMA llenamos TO llenamos_worker,llenamos_worker_fn,llenamos_webhook;
GRANT EXECUTE ON FUNCTION llenamos.actor_uid(),llenamos.is_platform() TO llenamos_worker_fn;

-- El worker actúa por restaurante dentro de una transacción (`app.restaurant_id`), sin ser miembro y sin la
-- comprobación de vencimiento: termina hechos ya confirmados (reintentos, borrados, privacidad).
CREATE OR REPLACE FUNCTION llenamos.can_access_restaurant(rid text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT llenamos.is_platform()
  AND rid=nullif(current_setting('app.restaurant_id',true),'')
  AND (pg_has_role(current_user,'llenamos_worker','member')
    OR (EXISTS(SELECT FROM llenamos.memberships m WHERE m.restaurant_id=rid AND m.uid=llenamos.actor_uid() AND m.active)
      AND EXISTS(SELECT FROM llenamos.restaurants r WHERE r.id=rid AND (r.entitlement_version IS NULL OR r.access_valid_until>now()))))
$$;
CREATE POLICY worker_restaurant ON llenamos.restaurants FOR SELECT TO llenamos_worker
  USING(id=nullif(current_setting('app.restaurant_id',true),''));
CREATE POLICY worker_location ON llenamos.locations FOR SELECT TO llenamos_worker
  USING(restaurant_id=nullif(current_setting('app.restaurant_id',true),''));
CREATE POLICY worker_membership ON llenamos.memberships FOR SELECT TO llenamos_worker
  USING(restaurant_id=nullif(current_setting('app.restaurant_id',true),'') AND active);

ALTER TABLE llenamos.outbox ADD COLUMN last_error varchar(300),ADD COLUMN finished_at timestamptz;
ALTER TABLE llenamos.jobs ADD COLUMN last_error varchar(300),ADD COLUMN finished_at timestamptz;
CREATE INDEX outbox_claim ON llenamos.outbox(available_at,id) WHERE status IN ('pending','leased');
CREATE INDEX jobs_claim ON llenamos.jobs(scheduled_at,id) WHERE status IN ('pending','leased');
CREATE INDEX outbox_finished ON llenamos.outbox(finished_at) WHERE status IN ('done','failed');
CREATE INDEX jobs_finished ON llenamos.jobs(finished_at) WHERE status IN ('done','failed');

CREATE POLICY worker_queue ON llenamos.outbox TO llenamos_worker_fn USING(true) WITH CHECK(true);
CREATE POLICY worker_queue ON llenamos.jobs TO llenamos_worker_fn USING(true) WITH CHECK(true);
GRANT SELECT,UPDATE,DELETE ON llenamos.outbox,llenamos.jobs TO llenamos_worker_fn;
GRANT SELECT,UPDATE ON llenamos.outbox,llenamos.jobs TO llenamos_worker;

-- Reclamar con lease: SKIP LOCKED evita que dos workers tomen lo mismo; un lease vencido se
-- reintenta, y al agotar los intentos pasa a cuarentena en lugar de repetirse sin fin.
DO $$ DECLARE spec record; BEGIN
  FOR spec IN SELECT * FROM (VALUES ('outbox','available_at','outbox'),('jobs','scheduled_at','jobs')) AS s(tbl,due,prefix) LOOP
    EXECUTE format($f$
      CREATE FUNCTION llenamos.worker_claim_%1$s(p_limit integer,p_lease_seconds integer,p_max_attempts integer)
      RETURNS TABLE(id uuid,restaurant_id varchar,kind varchar,payload jsonb,attempts integer,lease_id uuid)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $b$
      BEGIN
        IF p_limit NOT BETWEEN 1 AND 200 OR p_lease_seconds NOT BETWEEN 5 AND 3600 OR p_max_attempts NOT BETWEEN 1 AND 50 THEN
          RAISE EXCEPTION 'invalid_claim_arguments'; END IF;
        UPDATE llenamos.%1$I t SET status='quarantined',lease_id=NULL,lease_until=NULL,finished_at=now(),last_error='lease-agotado'
          WHERE t.status='leased' AND t.lease_until<=now() AND t.attempts>=p_max_attempts;
        -- Reparto justo: primero el más antiguo de cada restaurante, luego el segundo, etc.
        RETURN QUERY WITH cand AS (
          SELECT s.id,s.rn,s.due FROM (SELECT t.id,t.%2$I AS due,row_number() OVER (PARTITION BY t.restaurant_id ORDER BY t.%2$I,t.id) AS rn
            FROM llenamos.%1$I t
            WHERE (t.status='pending' AND t.%2$I<=now()) OR (t.status='leased' AND t.lease_until<=now() AND t.attempts<p_max_attempts)) s
          ORDER BY s.rn,s.due,s.id LIMIT p_limit*4),
        due AS (
          SELECT t.id FROM llenamos.%1$I t JOIN cand c ON c.id=t.id
          WHERE (t.status='pending' AND t.%2$I<=now()) OR (t.status='leased' AND t.lease_until<=now() AND t.attempts<p_max_attempts)
          ORDER BY c.rn,c.due,t.id LIMIT p_limit FOR UPDATE OF t SKIP LOCKED)
        UPDATE llenamos.%1$I t SET status='leased',attempts=t.attempts+1,lease_id=gen_random_uuid(),lease_until=now()+make_interval(secs=>p_lease_seconds)
          FROM due WHERE t.id=due.id
          RETURNING t.id,t.restaurant_id,t.kind,t.payload,t.attempts,t.lease_id;
      END $b$;
      -- Renovar el lease mientras el manejador sigue trabajando (falso si ya es de otro worker).
      CREATE FUNCTION llenamos.worker_extend_%1$s(p_id uuid,p_lease uuid,p_lease_seconds integer) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $b$
      DECLARE n integer; BEGIN
        IF p_lease_seconds NOT BETWEEN 5 AND 3600 THEN RAISE EXCEPTION 'invalid_lease'; END IF;
        UPDATE llenamos.%1$I t SET lease_until=now()+make_interval(secs=>p_lease_seconds) WHERE t.id=p_id AND t.lease_id=p_lease AND t.status='leased';
        GET DIAGNOSTICS n=ROW_COUNT;
        RETURN n=1;
      END $b$;
      -- outcome: done | failed (terminal) | quarantined | retry (con espera; cuarentena al agotar intentos)
      -- | defer (espera sin gastar intento: aún no hay quien lo atienda)
      CREATE FUNCTION llenamos.worker_finish_%1$s(p_id uuid,p_lease uuid,p_outcome text,p_delay_seconds integer,p_error text,p_max_attempts integer)
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $b$
      DECLARE n integer; BEGIN
        IF p_outcome NOT IN ('done','failed','quarantined','retry','defer') THEN RAISE EXCEPTION 'invalid_outcome'; END IF;
        UPDATE llenamos.%1$I t SET
          status=CASE WHEN p_outcome='defer' THEN 'pending' WHEN p_outcome='retry' THEN CASE WHEN t.attempts>=p_max_attempts THEN 'quarantined' ELSE 'pending' END ELSE p_outcome END,
          %2$I=CASE WHEN p_outcome='defer' OR (p_outcome='retry' AND t.attempts<p_max_attempts) THEN now()+make_interval(secs=>greatest(p_delay_seconds,0)) ELSE t.%2$I END,
          attempts=CASE WHEN p_outcome='defer' THEN greatest(t.attempts-1,0) ELSE t.attempts END,
          lease_id=NULL,lease_until=NULL,
          finished_at=CASE WHEN p_outcome='defer' OR (p_outcome='retry' AND t.attempts<p_max_attempts) THEN NULL ELSE now() END,
          last_error=left(p_error,300)
        WHERE t.id=p_id AND t.lease_id=p_lease AND t.status='leased';
        GET DIAGNOSTICS n=ROW_COUNT;
        RETURN n=1;
      END $b$;
    $f$,spec.tbl,spec.due);
  END LOOP;
END $$;
-- Mantenimiento: borra lo ya resuelto tras el periodo de retención (la cuarentena se conserva).
CREATE FUNCTION llenamos.worker_purge_queues(p_older_than interval,p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE a integer;b integer; BEGIN
  WITH d AS(SELECT id FROM llenamos.outbox WHERE status IN ('done','failed') AND finished_at<now()-p_older_than LIMIT p_limit)
    DELETE FROM llenamos.outbox o USING d WHERE o.id=d.id;
  GET DIAGNOSTICS a=ROW_COUNT;
  WITH d AS(SELECT id FROM llenamos.jobs WHERE status IN ('done','failed') AND finished_at<now()-p_older_than LIMIT p_limit)
    DELETE FROM llenamos.jobs o USING d WHERE o.id=d.id;
  GET DIAGNOSTICS b=ROW_COUNT;
  RETURN a+b;
END $$;
-- Credenciales selladas de un restaurante: solo el worker y el receptor de webhooks las piden.
CREATE POLICY worker_read ON llenamos.integration_secrets FOR SELECT TO llenamos_worker_fn USING(true);
GRANT SELECT ON llenamos.integration_secrets TO llenamos_worker_fn;
CREATE FUNCTION llenamos.worker_integration_ciphertext(p_rid text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT ciphertext FROM llenamos.integration_secrets WHERE restaurant_id=p_rid
$$;
-- Restaurantes con trabajo propio (mantenimiento por restaurante).
GRANT SELECT ON llenamos.restaurants TO llenamos_worker_fn;
CREATE POLICY worker_all_restaurants ON llenamos.restaurants FOR SELECT TO llenamos_worker_fn USING(true);
CREATE FUNCTION llenamos.worker_restaurants(p_after text,p_limit integer) RETURNS SETOF varchar
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT id FROM llenamos.restaurants WHERE id>coalesce(p_after,'') ORDER BY id LIMIT least(p_limit,500)
$$;

-- Webhooks: el receptor valida la firma con las credenciales del restaurante y anota el evento
-- una sola vez por (restaurante, proveedor, ID de evento). El cuerpo viaja por outbox.
CREATE TABLE llenamos.webhook_events (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  provider text NOT NULL CHECK(provider IN ('stripe','whatsapp')),
  event_id varchar(200) NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,provider,event_id)
);
CREATE INDEX webhook_events_received ON llenamos.webhook_events(received_at);
-- Registro de recepción sin cuerpo; el SECURITY DEFINER es el único camino sin sesión de usuario.
CREATE FUNCTION llenamos.webhook_accept(p_rid text,p_provider text,p_event text,p_outbox uuid,p_kind text,p_payload jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE n integer; BEGIN
  IF p_provider NOT IN ('stripe','whatsapp') OR p_kind<>'webhook.'||p_provider THEN RAISE EXCEPTION 'invalid_webhook'; END IF;
  INSERT INTO llenamos.webhook_events(restaurant_id,provider,event_id) VALUES(p_rid,p_provider,p_event) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n=0 THEN RETURN false; END IF;
  INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload) VALUES(p_outbox,p_rid,p_kind,p_payload) ON CONFLICT(id) DO NOTHING;
  RETURN true;
END $$;
CREATE FUNCTION llenamos.webhook_purge(p_older_than interval) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE n integer; BEGIN DELETE FROM llenamos.webhook_events WHERE received_at<now()-p_older_than; GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;
ALTER TABLE llenamos.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_fn ON llenamos.webhook_events TO llenamos_worker_fn USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,DELETE ON llenamos.webhook_events TO llenamos_worker_fn;
GRANT INSERT ON llenamos.outbox TO llenamos_worker_fn;

-- Secretos de verificación de firma, separados de las credenciales completas: el receptor de webhooks solo
-- puede pedir estos (otra clave derivada, AAD = restaurante + proveedor). Los escribe la plataforma al
-- guardar las integraciones.
CREATE TABLE llenamos.integration_webhook_secrets (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  provider text NOT NULL CHECK(provider IN ('stripe','whatsapp')),
  ciphertext text NOT NULL CHECK(length(ciphertext) BETWEEN 40 AND 20000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,provider)
);
ALTER TABLE llenamos.integration_webhook_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.integration_webhook_secrets FORCE ROW LEVEL SECURITY;
ALTER TABLE llenamos.integration_webhook_secrets OWNER TO llenamos_migrator;
CREATE POLICY platform_writer ON llenamos.integration_webhook_secrets TO llenamos_platform_writer USING(llenamos.is_platform()) WITH CHECK(llenamos.is_platform());
GRANT SELECT,INSERT,UPDATE,DELETE ON llenamos.integration_webhook_secrets TO llenamos_platform_writer;
CREATE POLICY signing_lookup ON llenamos.integration_webhook_secrets FOR SELECT TO llenamos_worker_fn USING(true);
GRANT SELECT ON llenamos.integration_webhook_secrets TO llenamos_worker_fn;
CREATE FUNCTION llenamos.platform_webhook_secrets(p_rid text,p_provider text,p_ciphertext text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
 PERFORM llenamos.assert_platform_actor();
 IF NOT EXISTS(SELECT FROM llenamos.platform_restaurants WHERE restaurant_id=p_rid) THEN RAISE EXCEPTION 'restaurant_missing' USING ERRCODE='P0002'; END IF;
 IF p_ciphertext IS NULL THEN DELETE FROM llenamos.integration_webhook_secrets WHERE restaurant_id=p_rid AND provider=p_provider;
 ELSE INSERT INTO llenamos.integration_webhook_secrets(restaurant_id,provider,ciphertext) VALUES(p_rid,p_provider,p_ciphertext)
   ON CONFLICT(restaurant_id,provider) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=now(); END IF;
END $$;
ALTER FUNCTION llenamos.platform_webhook_secrets(text,text,text) OWNER TO llenamos_platform_writer;
REVOKE ALL ON FUNCTION llenamos.platform_webhook_secrets(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.platform_webhook_secrets(text,text,text) TO llenamos_app;
CREATE FUNCTION llenamos.webhook_signing_secret(p_rid text,p_provider text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT ciphertext FROM llenamos.integration_webhook_secrets WHERE restaurant_id=p_rid AND provider=p_provider
$$;

-- Bajas pedidas por el propio destinatario (STOP por WhatsApp): el marketing no vuelve a salir hacia él.
CREATE TABLE llenamos.message_optouts (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  channel text NOT NULL CHECK(channel IN ('email','whatsapp')),
  recipient varchar(254) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,channel,recipient)
);

-- Resultado de cada aviso. El ID es el del outbox (clave estable ante el proveedor).
CREATE TABLE llenamos.message_deliveries (
  id uuid PRIMARY KEY,
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  channel text NOT NULL CHECK(channel IN ('email','whatsapp')),
  template varchar(60) NOT NULL,
  recipient varchar(254) NOT NULL,
  language text NOT NULL DEFAULT 'es',
  status text NOT NULL CHECK(status IN ('sent','not_configured','failed','cancelled')),
  provider varchar(40),
  provider_message_id varchar(200),
  context jsonb NOT NULL DEFAULT '{}',
  purpose text,
  rendered_subject varchar(300),
  attempts integer NOT NULL DEFAULT 0,
  last_error varchar(300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX message_deliveries_provider ON llenamos.message_deliveries(restaurant_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX message_deliveries_recent ON llenamos.message_deliveries(restaurant_id,created_at DESC,id);
CREATE INDEX message_deliveries_recipient ON llenamos.message_deliveries(restaurant_id,recipient);

-- Archivos privados: los bytes viven en un volumen fuera de la raíz pública; aquí solo metadatos.
CREATE TABLE llenamos.files (
  id uuid PRIMARY KEY,
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  purpose text NOT NULL CHECK(purpose ~ '^[a-z][a-z0-9_]{1,40}$'),
  owner_uid text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes>0),
  sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  display_name varchar(120) NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX files_listing ON llenamos.files(restaurant_id,purpose,created_at DESC,id) WHERE status='active';

-- Privacidad: solicitudes de exportación o borrado de una persona (id opaco de cliente).
CREATE TABLE llenamos.privacy_requests (
  id uuid PRIMARY KEY,
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  subject_id varchar(128) NOT NULL,
  kind text NOT NULL CHECK(kind IN ('export','erase')),
  status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','verified','running','completed','blocked','failed')),
  requested_by text NOT NULL,
  verified_by text,
  evidence_id varchar(128),
  reason varchar(200) NOT NULL,
  request_key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL,
  artifact_file_id uuid REFERENCES llenamos.files(id),
  expires_at timestamptz,
  processed integer NOT NULL DEFAULT 0,
  error varchar(300),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(restaurant_id,requested_by,request_key)
);
CREATE INDEX privacy_requests_listing ON llenamos.privacy_requests(restaurant_id,id);
-- Pruebas de identidad aportadas por quien atiende a la persona (las registra el módulo de clientes).
CREATE TABLE llenamos.privacy_evidence (
  id varchar(128) NOT NULL,
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  subject_id varchar(128) NOT NULL,
  method text NOT NULL CHECK(method IN ('in_person','verified_channel')),
  expires_at timestamptz NOT NULL,
  recorded_by text NOT NULL,
  PRIMARY KEY(restaurant_id,id)
);
-- Descargas de exportaciones: ticket opaco (solo se guarda su huella), un uso y corta vida.
CREATE TABLE llenamos.privacy_downloads (
  ticket_hash char(64) PRIMARY KEY CHECK(ticket_hash ~ '^[a-f0-9]{64}$'),
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  request_id uuid NOT NULL REFERENCES llenamos.privacy_requests(id),
  actor_uid text NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false
);
-- Barrera contra restaurar datos borrados: huella del sujeto borrado, sin datos personales.
CREATE TABLE llenamos.privacy_tombstones (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  subject_hash char(64) NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
  erased_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,subject_hash)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['message_deliveries','message_optouts','files','privacy_requests','privacy_evidence','privacy_downloads','privacy_tombstones'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_access ON llenamos.%I USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id))',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['webhook_events','message_optouts','message_deliveries','files','privacy_requests','privacy_evidence','privacy_downloads','privacy_tombstones'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator',t);
  END LOOP;
END $$;
GRANT SELECT ON llenamos.message_deliveries,llenamos.privacy_tombstones,llenamos.privacy_evidence TO llenamos_app;
GRANT SELECT,INSERT,UPDATE ON llenamos.files,llenamos.privacy_requests,llenamos.privacy_downloads TO llenamos_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON llenamos.message_deliveries,llenamos.message_optouts TO llenamos_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON llenamos.files,llenamos.privacy_requests,llenamos.privacy_downloads,llenamos.privacy_evidence TO llenamos_worker;
GRANT SELECT,INSERT,DELETE ON llenamos.privacy_tombstones TO llenamos_worker;
GRANT INSERT ON llenamos.privacy_evidence TO llenamos_app;
-- Solo la función de lectura pública (SECURITY DEFINER) ve archivos sin sesión de miembro.
CREATE POLICY public_lookup ON llenamos.files FOR SELECT TO llenamos_worker_fn USING(true);
GRANT SELECT ON llenamos.files TO llenamos_worker_fn;

-- Descarga pública de archivos marcados como públicos (fotos de la carta): sin sesión, sin listados.
CREATE FUNCTION llenamos.file_public_lookup(p_rid text,p_id uuid) RETURNS TABLE(content_type text,size_bytes bigint,sha256 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT f.content_type,f.size_bytes,f.sha256::text FROM llenamos.files f
  WHERE f.restaurant_id=p_rid AND f.id=p_id AND f.status='active' AND f.purpose='carta_foto'
    AND EXISTS(SELECT FROM llenamos.restaurants r WHERE r.id=f.restaurant_id AND (r.entitlement_version IS NULL OR r.access_valid_until>now()))
$$;

-- Restauración: reaplica un borrado de privacidad posterior a la copia. Solo el propietario o un superusuario
-- (procedimiento de restauración) puede ejecutarla; el worker lo completa con `privacidad.procesar`.
CREATE FUNCTION llenamos.restore_reapply_erasure(p_rid text,p_subject text) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,llenamos AS $$
DECLARE rid uuid:=md5('restauracion:'||p_rid||':'||p_subject)::uuid; BEGIN
  IF EXISTS(SELECT FROM llenamos.privacy_requests WHERE restaurant_id=p_rid AND subject_id=p_subject AND kind='erase' AND status='completed') THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT FROM llenamos.restaurants WHERE id=p_rid) THEN RETURN false; END IF;
  INSERT INTO llenamos.privacy_requests(id,restaurant_id,subject_id,kind,status,requested_by,verified_by,reason,request_key,request_hash)
    VALUES(rid,p_rid,p_subject,'erase','verified','restauracion','restauracion','Borrado reaplicado tras restaurar una copia anterior',
      'restore_'||md5(p_rid||p_subject),repeat('0',64)) ON CONFLICT DO NOTHING;
  INSERT INTO llenamos.jobs(id,restaurant_id,kind,deduplication_key,payload,scheduled_at)
    VALUES(rid,p_rid,'privacidad.procesar','restore:'||rid::text,jsonb_build_object('requestId',rid),now()) ON CONFLICT DO NOTHING;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION llenamos.restore_reapply_erasure(text,text) FROM PUBLIC;

DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig,p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='llenamos' AND p.proname IN ('worker_claim_outbox','worker_claim_jobs','worker_finish_outbox','worker_finish_jobs',
      'worker_extend_outbox','worker_extend_jobs','worker_purge_queues','worker_integration_ciphertext','worker_restaurants',
      'webhook_accept','webhook_signing_secret','webhook_purge','file_public_lookup') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO llenamos_worker_fn',f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f.sig);
    IF f.name='file_public_lookup' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO llenamos_app',f.sig);
    ELSIF f.name IN ('webhook_accept','webhook_signing_secret') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO llenamos_webhook',f.sig);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO llenamos_worker',f.sig);
    END IF;
  END LOOP;
END $$;
