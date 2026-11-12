-- Revisión de fidelización, campañas y análisis (V7). No toca 011 a 011d: todo lo nuevo va aquí.

-- ---- Permisos más estrechos ------------------------------------------------------------------------------------
-- customer_marketing no la toca ningún procedimiento sin identidad: fuera la custodia total.
DROP POLICY definer_custody ON llenamos.customer_marketing;
-- Los espejos de V3 (disparadores de abajo) escriben sin ser miembros (reserva pública), pero solo en el restaurante del contexto.
CREATE POLICY mirror ON llenamos.customer_marketing TO llenamos_migrator
  USING(llenamos.public_scope(restaurant_id) OR llenamos.can_access_restaurant(restaurant_id) OR restaurant_id=nullif(current_setting('app.restaurant_id',true),''))
  WITH CHECK(llenamos.public_scope(restaurant_id) OR llenamos.can_access_restaurant(restaurant_id) OR restaurant_id=nullif(current_setting('app.restaurant_id',true),''));
-- marketing_consents es un libro: los procedimientos solo añaden (la baja pública y el espejo de consents).
DROP POLICY definer_custody ON llenamos.marketing_consents;
CREATE POLICY consent_insert ON llenamos.marketing_consents FOR INSERT TO llenamos_migrator
  WITH CHECK(restaurant_id=nullif(current_setting('app.restaurant_id',true),'') OR llenamos.public_scope(restaurant_id));
-- `ON CONFLICT DO NOTHING` comprueba también la lectura de la fila nueva: solo las que escribe la baja y el espejo.
CREATE POLICY consent_conflict ON llenamos.marketing_consents FOR SELECT TO llenamos_migrator
  USING((id LIKE 'unsubscribe.%' OR id LIKE 'reservation.%') AND (restaurant_id=nullif(current_setting('app.restaurant_id',true),'') OR llenamos.public_scope(restaurant_id)));

-- location_exists lo ve cualquier miembro del restaurante (distingue «no existe» de «no es tuyo»), nadie más.
DROP POLICY migrator_locations ON llenamos.locations;
CREATE POLICY migrator_locations ON llenamos.locations FOR SELECT TO llenamos_migrator USING(llenamos.can_access_restaurant(restaurant_id));
CREATE OR REPLACE FUNCTION llenamos.location_exists(rid text, lid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT llenamos.can_access_restaurant(rid) AND EXISTS(SELECT 1 FROM llenamos.locations WHERE restaurant_id=rid AND id=lid)
$$;

-- Cancelar una campaña: solo quien gestiona campañas (propietario o encargado) del restaurante.
CREATE OR REPLACE FUNCTION llenamos.marketing_cancel_campaign(rid text,p_campaign text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
  IF NOT llenamos.can_access_restaurant(rid) OR NOT EXISTS(
    SELECT 1 FROM llenamos.memberships m WHERE m.restaurant_id=rid AND m.uid=llenamos.actor_uid() AND m.active AND m.role IN ('owner','manager')
  ) THEN RAISE EXCEPTION 'marketing_denied'; END IF;
  RETURN llenamos.marketing_cancel_pending(rid,NULL,NULL,p_campaign);
END $$;

-- Los destinatarios del resumen los consulta solo quien dirige el restaurante (o el worker).
CREATE OR REPLACE FUNCTION llenamos.analytics_recipients(rid text, uids text[]) RETURNS TABLE(uid text, role text, active boolean, location_ids text[], email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT m.uid,m.role,m.active,m.location_ids,m.email::text FROM llenamos.memberships m
  WHERE m.restaurant_id=rid AND m.uid=ANY(uids) AND cardinality(uids)<=50
    AND rid=nullif(current_setting('app.restaurant_id',true),'')
    AND NOT llenamos.is_platform()
    AND (EXISTS(SELECT FROM llenamos.memberships a WHERE a.restaurant_id=rid AND a.uid=llenamos.actor_uid() AND a.active AND a.role IN ('owner','manager'))
      OR (CASE WHEN EXISTS(SELECT FROM pg_roles WHERE rolname='llenamos_worker') THEN pg_has_role(session_user,'llenamos_worker','member') ELSE false END))
$$;

-- ---- Índice para ganchos.ts (devoluciones de una tanda de puntos) --------------------------------------------------
CREATE INDEX loyalty_movements_earn_reversal ON llenamos.loyalty_movements(restaurant_id,earn_movement_id) WHERE kind='earn_reversal';


-- ---- Custodia acotada al restaurante de la transacción (sustituye a los USING(true) de 011c) ------------------------------
-- Las funciones SECURITY DEFINER de marketing fijan `app.restaurant_id` antes de tocar estas tablas (la baja pública, que no tiene identidad, lo hace
-- tras resolver el slug): el propietario solo ve filas del restaurante de esa transacción.
DROP POLICY definer_custody ON llenamos.marketing_campaigns;
DROP POLICY definer_custody ON llenamos.marketing_campaign_recipients;
DROP POLICY definer_custody ON llenamos.marketing_unsubscribe_tokens;
DROP POLICY definer_custody ON llenamos.marketing_unsubscribe_limits;
CREATE POLICY ctx_custody ON llenamos.marketing_campaigns TO llenamos_migrator USING(restaurant_id=nullif(current_setting('app.restaurant_id',true),'')) WITH CHECK(restaurant_id=nullif(current_setting('app.restaurant_id',true),''));
CREATE POLICY ctx_custody ON llenamos.marketing_campaign_recipients TO llenamos_migrator USING(restaurant_id=nullif(current_setting('app.restaurant_id',true),'')) WITH CHECK(restaurant_id=nullif(current_setting('app.restaurant_id',true),''));
CREATE POLICY ctx_custody ON llenamos.marketing_unsubscribe_tokens TO llenamos_migrator USING(restaurant_id=nullif(current_setting('app.restaurant_id',true),'')) WITH CHECK(restaurant_id=nullif(current_setting('app.restaurant_id',true),''));
-- Los contadores no tienen restaurante: el de IP y el de slugs inexistentes son comunes; el de un slug, solo el del restaurante de la transacción;
-- y la poda de ventanas viejas solo ve las anteriores al límite que fija la propia función (`app.unsub_prune_before`).
CREATE POLICY ctx_custody ON llenamos.marketing_unsubscribe_limits TO llenamos_migrator
  USING(bucket='unknown' OR bucket LIKE 'ip:%' OR bucket='slug:'||nullif(current_setting('app.restaurant_id',true),'')
    OR window_start<nullif(current_setting('app.unsub_prune_before',true),'')::timestamptz)
  WITH CHECK(bucket='unknown' OR bucket LIKE 'ip:%' OR bucket='slug:'||nullif(current_setting('app.restaurant_id',true),''));

-- Cancelar pendientes (redefinida: la de 011c ya no tendría acceso). Fija el restaurante de la transacción mientras trabaja y lo restaura.
CREATE OR REPLACE FUNCTION llenamos.marketing_cancel_pending(rid text,p_customer text,p_purpose text,p_campaign text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE n integer; v_old text:=coalesce(current_setting('app.restaurant_id',true),'');
BEGIN
  PERFORM set_config('app.restaurant_id',rid,true);
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
  PERFORM set_config('app.restaurant_id',v_old,true);
  RETURN n;
END $$;

-- ---- Baja pública -------------------------------------------------------------------------------------------------
-- Primero el token por hash: una baja legítima no gasta el contador del slug. Solo los fallos cuentan contra el slug
-- (o contra el contador común de slugs inexistentes) y cada IP verificada tiene el suyo. El enlace no caduca.
DROP FUNCTION llenamos.marketing_unsubscribe(text,text,timestamptz,integer,integer,integer,integer);
CREATE FUNCTION llenamos.marketing_unsubscribe(p_slug text,p_hash text,p_now timestamptz,p_window_seconds integer,p_fail_limit integer,p_unknown_limit integer,p_ip_hash text,p_ip_limit integer)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE v_rid text; v_win timestamptz; v_hits integer; v_tok llenamos.marketing_unsubscribe_tokens; v_bucket text;
BEGIN
  IF p_hash !~ '^[a-f0-9]{64}$' OR length(p_slug)>128 OR p_window_seconds NOT BETWEEN 1 AND 86400
     OR p_fail_limit NOT BETWEEN 1 AND 100000 OR p_unknown_limit NOT BETWEEN 1 AND 100000 OR p_ip_limit NOT BETWEEN 1 AND 100000
     OR (p_ip_hash IS NOT NULL AND p_ip_hash !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'marketing_invalid'; END IF;
  v_win:=to_timestamp(floor(extract(epoch FROM p_now)/p_window_seconds)*p_window_seconds);
  PERFORM set_config('app.unsub_prune_before',(v_win-(p_window_seconds*3)*interval '1 second')::text,true);
  DELETE FROM llenamos.marketing_unsubscribe_limits WHERE ctid IN (
    SELECT l.ctid FROM llenamos.marketing_unsubscribe_limits l WHERE l.window_start<v_win-(p_window_seconds*3)*interval '1 second' LIMIT 500);
  IF p_ip_hash IS NOT NULL THEN
    INSERT INTO llenamos.marketing_unsubscribe_limits AS l(bucket,window_start,hits) VALUES('ip:'||p_ip_hash,v_win,1)
      ON CONFLICT ON CONSTRAINT marketing_unsubscribe_limits_pkey DO UPDATE SET hits=l.hits+1 RETURNING l.hits INTO v_hits;
    IF v_hits>p_ip_limit THEN RETURN 'limited'; END IF;
  END IF;
  SELECT r.id INTO v_rid FROM llenamos.restaurants r WHERE r.slug=p_slug;
  IF v_rid IS NOT NULL THEN
    PERFORM set_config('app.restaurant_id',v_rid,true);
    SELECT * INTO v_tok FROM llenamos.marketing_unsubscribe_tokens t WHERE t.restaurant_id=v_rid AND t.token_hash=p_hash FOR UPDATE;
    IF v_tok.token_hash IS NOT NULL THEN
      IF v_tok.used_at IS NULL THEN
        -- El disparador de marketing_consents cancela los mensajes pendientes de ese cliente y propósito.
        INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id)
          VALUES(v_rid,'unsubscribe.'||p_hash,v_tok.customer_id,v_tok.purpose,'withdrawn','unsubscribe',p_now,'public',v_tok.message_id::text) ON CONFLICT DO NOTHING;
        UPDATE llenamos.marketing_unsubscribe_tokens t SET used_at=p_now WHERE t.restaurant_id=v_rid AND t.token_hash=p_hash;
        INSERT INTO llenamos.events(restaurant_id,topic,entity_id,payload) VALUES(v_rid,'campanas.baja',v_tok.campaign_id,jsonb_build_object('purpose',v_tok.purpose));
        -- Rastro de auditoría de la baja: sin contacto ni cliente, solo campaña y propósito.
        INSERT INTO llenamos.events(restaurant_id,topic,entity_id,payload) VALUES(v_rid,'marketing.unsubscribed',v_tok.campaign_id,jsonb_build_object('purpose',v_tok.purpose,'source','public'));
      END IF;
      RETURN 'ok';
    END IF;
  END IF;
  -- Un fallo (slug o token que no existe) sí cuenta; los slugs inexistentes comparten un único contador.
  v_bucket:=CASE WHEN v_rid IS NULL THEN 'unknown' ELSE 'slug:'||v_rid END;
  INSERT INTO llenamos.marketing_unsubscribe_limits AS l(bucket,window_start,hits) VALUES(v_bucket,v_win,1)
    ON CONFLICT ON CONSTRAINT marketing_unsubscribe_limits_pkey DO UPDATE SET hits=l.hits+1 RETURNING l.hits INTO v_hits;
  IF v_hits>(CASE WHEN v_rid IS NULL THEN p_unknown_limit ELSE p_fail_limit END) THEN RETURN 'limited'; END IF;
  RETURN 'ok';
END $$;
ALTER FUNCTION llenamos.marketing_unsubscribe(text,text,timestamptz,integer,integer,integer,text,integer) OWNER TO llenamos_migrator;
REVOKE ALL ON FUNCTION llenamos.marketing_unsubscribe(text,text,timestamptz,integer,integer,integer,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.marketing_unsubscribe(text,text,timestamptz,integer,integer,integer,text,integer) TO llenamos_app;
DROP POLICY marketing_events ON llenamos.events;
CREATE POLICY marketing_events ON llenamos.events FOR INSERT TO llenamos_migrator WITH CHECK(topic IN ('campanas.baja','marketing.unsubscribed'));

-- ---- Poda y privacidad (solo el worker, con el restaurante fijado en la transacción) ---------------------------------
CREATE FUNCTION llenamos.marketing_worker_only(rid text) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
  IF rid IS DISTINCT FROM nullif(current_setting('app.restaurant_id',true),'') OR NOT (CASE WHEN EXISTS(SELECT FROM pg_roles WHERE rolname='llenamos_worker')
    THEN pg_has_role(session_user,'llenamos_worker','member') ELSE false END) THEN RAISE EXCEPTION 'marketing_denied'; END IF;
END $$;

-- Tokens usados de más de 90 días, no usados pasados sus 2 años (`expires_at` solo marca cuándo se poda: el enlace no caduca para la baja)
-- y destinatarios de campañas terminadas hace más de un año. Por lotes.
CREATE FUNCTION llenamos.marketing_prune(rid text,p_now timestamptz,p_batch integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE n integer:=0; k integer;
BEGIN
  PERFORM llenamos.marketing_worker_only(rid);
  WITH gone AS (SELECT token_hash FROM llenamos.marketing_unsubscribe_tokens WHERE restaurant_id=rid
    AND ((used_at IS NOT NULL AND used_at<p_now-interval '90 days')
      -- Un enlace sin usar solo se poda si la persona ya no existe como cliente: mientras siga, su correo antiguo debe poder darse de baja.
      OR (expires_at<p_now AND NOT EXISTS(SELECT 1 FROM llenamos.customer_marketing cm WHERE cm.restaurant_id=rid AND cm.customer_id=llenamos.marketing_unsubscribe_tokens.customer_id AND NOT cm.redacted)))
    ORDER BY expires_at LIMIT least(p_batch,5000))
  DELETE FROM llenamos.marketing_unsubscribe_tokens t USING gone WHERE t.restaurant_id=rid AND t.token_hash=gone.token_hash;
  GET DIAGNOSTICS k=ROW_COUNT; n:=n+k;
  WITH gone AS (SELECT r.customer_id,r.campaign_id FROM llenamos.marketing_campaign_recipients r JOIN llenamos.marketing_campaigns c ON c.restaurant_id=r.restaurant_id AND c.id=r.campaign_id
    WHERE r.restaurant_id=rid AND c.status IN ('sent','cancelled') AND r.at<p_now-interval '365 days' LIMIT least(p_batch,5000))
  DELETE FROM llenamos.marketing_campaign_recipients r USING gone WHERE r.restaurant_id=rid AND r.customer_id=gone.customer_id AND r.campaign_id=gone.campaign_id;
  GET DIAGNOSTICS k=ROW_COUNT; n:=n+k;
  RETURN n;
END $$;

-- Un borrado de privacidad: cancela lo pendiente, quita el contacto cifrado en hash y el nombre del outbox, y retira tokens y registro de frecuencia.
CREATE POLICY marketing_scrub ON llenamos.outbox FOR UPDATE TO llenamos_migrator USING(kind='marketing.campaign_message') WITH CHECK(kind='marketing.campaign_message');
CREATE FUNCTION llenamos.marketing_erase_customer(rid text,p_customer text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE n integer:=0; k integer;
BEGIN
  PERFORM llenamos.marketing_worker_only(rid);
  n:=llenamos.marketing_cancel_pending(rid,p_customer,NULL,NULL);
  UPDATE llenamos.outbox o SET payload=jsonb_set(o.payload,'{data,guestName}','"Cliente"') WHERE o.restaurant_id=rid AND o.kind='marketing.campaign_message'
    AND o.payload->>'customerId'=p_customer AND o.payload#>>'{data,guestName}' IS DISTINCT FROM 'Cliente';
  GET DIAGNOSTICS k=ROW_COUNT; n:=n+k;
  -- Los destinatarios en cola se cancelan por cliente y mensaje, no por el payload (el contribuyente común de avisos ya lo ha vaciado).
  WITH q AS (SELECT campaign_id,message_id FROM llenamos.marketing_campaign_recipients WHERE restaurant_id=rid AND customer_id=p_customer AND status='queued'),
  gone AS (DELETE FROM llenamos.outbox o USING q WHERE o.restaurant_id=rid AND o.id=q.message_id AND o.status IN ('pending','failed') RETURNING q.campaign_id,q.message_id),
  upd AS (UPDATE llenamos.marketing_campaign_recipients r SET status='cancelled' FROM gone WHERE r.restaurant_id=rid AND r.customer_id=p_customer AND r.message_id=gone.message_id AND r.status='queued' RETURNING r.campaign_id),
  per AS (SELECT campaign_id,count(*)::integer AS c FROM upd GROUP BY campaign_id)
  UPDATE llenamos.marketing_campaigns c SET stat_cancelled=c.stat_cancelled+per.c,stat_queued=greatest(c.stat_queued-per.c,0),updated_at=now() FROM per WHERE c.restaurant_id=rid AND c.id=per.campaign_id;
  GET DIAGNOSTICS k=ROW_COUNT; n:=n+k;
  UPDATE llenamos.marketing_campaign_recipients SET contact_hash=NULL WHERE restaurant_id=rid AND customer_id=p_customer AND contact_hash IS NOT NULL;
  GET DIAGNOSTICS k=ROW_COUNT; n:=n+k;
  DELETE FROM llenamos.marketing_unsubscribe_tokens WHERE restaurant_id=rid AND customer_id=p_customer;
  GET DIAGNOSTICS k=ROW_COUNT; n:=n+k;
  RETURN n;
END $$;

-- loyalty_movements solo admite INSERT: esta función es la única vía de anonimizar el texto libre (motivos) de un cliente borrado.
-- Dentro de una función SECURITY DEFINER `can_access_restaurant` ya no reconoce al worker (mira `current_user`): vale el restaurante fijado en la
-- transacción, y `marketing_worker_only` ya comprobó que quien llama es el worker.
CREATE POLICY loyalty_anonymize ON llenamos.loyalty_movements FOR UPDATE TO llenamos_migrator
  USING(restaurant_id=nullif(current_setting('app.restaurant_id',true),'')) WITH CHECK(restaurant_id=nullif(current_setting('app.restaurant_id',true),''));
CREATE POLICY loyalty_anonymize_read ON llenamos.loyalty_movements FOR SELECT TO llenamos_migrator USING(restaurant_id=nullif(current_setting('app.restaurant_id',true),''));
CREATE FUNCTION llenamos.loyalty_anonymize(rid text,p_customer text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE n integer;
BEGIN
  PERFORM llenamos.marketing_worker_only(rid);
  UPDATE llenamos.loyalty_movements SET reason=NULL WHERE restaurant_id=rid AND customer_id=p_customer AND reason IS NOT NULL;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='llenamos' AND p.proname IN ('marketing_worker_only','marketing_prune','marketing_erase_customer','loyalty_anonymize') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO llenamos_migrator',f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO llenamos_app',f);
  END LOOP;
END $$;

-- ---- Espejo de V3 (customers, consents, reservation_origins, reservations) sin tocar el módulo de reservas -------------
-- Ficha de cliente → proyección de marketing. Una ficha ya suprimida no se vuelve a rellenar desde V3.
CREATE FUNCTION llenamos.clientes_espejo() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE d jsonb:=NEW.data; v_last timestamptz; v_old text:=coalesce(current_setting('app.restaurant_id',true),''); v_red boolean:=coalesce(d->>'privacyRedacted','false')='true';
BEGIN
  -- La fila ya pasó la RLS de `customers` (reserva pública, alta de sala, importación…): se escribe en SU restaurante sea cual sea el contexto de quien llama.
  PERFORM set_config('app.restaurant_id',NEW.restaurant_id,true);
  v_last:=CASE WHEN d->>'lastVisitAt' ~ '^[0-9]+$' THEN to_timestamp((d->>'lastVisitAt')::bigint/1000.0) ELSE NULL END;
  INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name,phone,email,language,visits,no_shows,last_visit_at,spent_cents,tags,redacted)
  VALUES(NEW.restaurant_id,NEW.id,CASE WHEN v_red THEN '' ELSE left(coalesce(d->>'name',''),120) END,CASE WHEN v_red THEN NULL ELSE left(nullif(d->>'phone',''),30) END,CASE WHEN v_red THEN NULL ELSE left(nullif(d->>'email',''),254) END,
    CASE WHEN d->>'language' IN ('es','ca','en') THEN d->>'language' ELSE 'es' END,
    CASE WHEN d->>'visits' ~ '^[0-9]+$' THEN (d->>'visits')::integer ELSE 0 END,
    CASE WHEN d->>'noShows' ~ '^[0-9]+$' THEN (d->>'noShows')::integer ELSE 0 END,
    v_last,
    CASE WHEN d->>'spentCents' ~ '^[0-9]+$' THEN (d->>'spentCents')::bigint ELSE 0 END,
    CASE WHEN NOT v_red AND jsonb_typeof(d->'tags')='array' THEN ARRAY(SELECT jsonb_array_elements_text(d->'tags')) ELSE '{}' END,
    v_red)
  ON CONFLICT(restaurant_id,customer_id) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,email=EXCLUDED.email,language=EXCLUDED.language,
    visits=EXCLUDED.visits,no_shows=EXCLUDED.no_shows,last_visit_at=EXCLUDED.last_visit_at,
    -- El gasto lo suma V11 en la ficha de reservas (`spentCents`); una actualización de la ficha sin ese campo no lo pone a 0.
    spent_cents=CASE WHEN d ? 'spentCents' THEN EXCLUDED.spent_cents ELSE llenamos.customer_marketing.spent_cents END,tags=EXCLUDED.tags,redacted=EXCLUDED.redacted,updated_at=now()
    WHERE NOT llenamos.customer_marketing.redacted;
  PERFORM set_config('app.restaurant_id',v_old,true);
  RETURN NULL;
END $$;
CREATE TRIGGER clientes_espejo AFTER INSERT OR UPDATE OF data ON llenamos.customers FOR EACH ROW EXECUTE FUNCTION llenamos.clientes_espejo();

-- Permiso de la reserva → libro de permisos de marketing (id estable: repetir no duplica; la hora es la del servidor).
CREATE FUNCTION llenamos.permisos_espejo() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE d jsonb:=NEW.data; v_old text:=coalesce(current_setting('app.restaurant_id',true),'');
BEGIN
  PERFORM set_config('app.restaurant_id',NEW.restaurant_id,true);
  IF d->>'purpose' IN ('marketing_email','marketing_whatsapp','digital_receipt') AND d->>'status' IN ('granted','withdrawn')
     AND d->>'customerId' ~ '^[0-9a-f]{20}$' AND d->>'source' IN ('public','staff','import') THEN
    INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id)
    VALUES(NEW.restaurant_id,NEW.id,d->>'customerId',d->>'purpose',d->>'status',left(coalesce(d->>'policyVersion','x'),80),clock_timestamp(),d->>'source',left(coalesce(d->>'evidenceId','x'),128))
    ON CONFLICT DO NOTHING;
  END IF;
  PERFORM set_config('app.restaurant_id',v_old,true);
  RETURN NULL;
END $$;
CREATE TRIGGER permisos_espejo AFTER INSERT ON llenamos.consents FOR EACH ROW EXECUTE FUNCTION llenamos.permisos_espejo();

-- V3 guarda el origen como JSON en `data`: las columnas que lee el informe se rellenan desde ahí.
CREATE FUNCTION llenamos.origen_columnas() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,llenamos AS $$
DECLARE d jsonb:=NEW.data;
BEGIN
  NEW.final_status:=coalesce((SELECT r.status FROM llenamos.reservations r WHERE r.restaurant_id=NEW.restaurant_id AND r.id=NEW.reservation_id),NEW.final_status);
  IF d IS NULL OR d='{}'::jsonb THEN RETURN NEW; END IF;
  NEW.channel:=coalesce(nullif(d->>'channel',''),NEW.channel);
  NEW.paid:=coalesce((d->>'paid')::boolean,NEW.paid);
  NEW.source:=left(d->>'source',100); NEW.medium:=left(d->>'medium',100); NEW.campaign:=left(d->>'campaign',100);
  NEW.content:=left(d->>'content',100); NEW.term:=left(d->>'term',100); NEW.ad_id:=left(d->>'adId',100);
  NEW.campaign_id:=left(d->>'campaignId',64);
  NEW.click_ids:=CASE WHEN jsonb_typeof(d->'clickIds')='array' THEN ARRAY(SELECT jsonb_array_elements_text(d->'clickIds')) ELSE NEW.click_ids END;
  NEW.referrer_host:=left(d->>'referrerHost',253); NEW.embed_host:=left(d->>'embedHost',253);
  NEW.reservation_source:=left(coalesce(nullif(d->>'reservationSource',''),NEW.reservation_source),40);
  IF d->>'date' ~ '^\d{4}-\d{2}-\d{2}$' THEN NEW.service_date:=(d->>'date')::date; END IF;
  IF d->>'partySize' ~ '^[0-9]+$' AND (d->>'partySize')::integer>=1 THEN NEW.party_size:=(d->>'partySize')::integer; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER origen_columnas BEFORE INSERT ON llenamos.reservation_origins FOR EACH ROW EXECUTE FUNCTION llenamos.origen_columnas();

-- Estado final de la reserva → su origen (comensales y estado; las ventas las pone caja con updateOriginOutcome) y, si la reserva se sienta,
-- termina, no se presenta o se cancela, un trabajo `clientes.reserva_cambiada` para que el worker dé el sello de Repite y anote el evento
-- de automatización. El ID y la clave dependen de la reserva y el estado: repetir no duplica. Sin tocar el módulo de reservas.
CREATE POLICY clientes_jobs ON llenamos.jobs FOR INSERT TO llenamos_migrator WITH CHECK(kind='clientes.reserva_cambiada');
CREATE POLICY clientes_jobs_read ON llenamos.jobs FOR SELECT TO llenamos_migrator USING(kind='clientes.reserva_cambiada');
CREATE FUNCTION llenamos.origen_resultado() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
  UPDATE llenamos.reservation_origins SET final_status=NEW.status,
    party_size=CASE WHEN NEW.data->>'partySize' ~ '^[0-9]+$' AND (NEW.data->>'partySize')::integer>=1 THEN (NEW.data->>'partySize')::integer ELSE party_size END
  WHERE restaurant_id=NEW.restaurant_id AND reservation_id=NEW.id AND (final_status IS DISTINCT FROM NEW.status);
  IF NEW.status IN ('seated','finished','no_show','cancelled') THEN
    INSERT INTO llenamos.jobs(id,restaurant_id,kind,deduplication_key,payload,scheduled_at)
    VALUES(md5('clientes.reserva_cambiada:'||NEW.restaurant_id||':'||NEW.id||':'||NEW.status)::uuid,NEW.restaurant_id,'clientes.reserva_cambiada',left(NEW.id||':'||NEW.status,256),
      jsonb_build_object('reservationId',NEW.id,'locationId',NEW.location_id,'status',NEW.status),now())
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER origen_resultado AFTER INSERT OR UPDATE OF status ON llenamos.reservations FOR EACH ROW EXECUTE FUNCTION llenamos.origen_resultado();

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='llenamos' AND p.proname IN ('clientes_espejo','permisos_espejo','origen_columnas','origen_resultado') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO llenamos_migrator',f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  END LOOP;
END $$;

-- Previsión de ocupación: las mesas del historial se buscan por hora de apertura (sala no tenía índice por fecha).
CREATE INDEX sala_table_sessions_opened ON llenamos.sala_table_sessions(restaurant_id,location_id,((doc->>'openedAt')::bigint));

-- repite_link (011b) corre como llenamos_platform_writer y toca tablas con la política tenant_access: sin EXECUTE en estas funciones fallaba
-- con «permission denied for function can_access_restaurant» antes de escribir nada.
GRANT EXECUTE ON FUNCTION llenamos.actor_uid(), llenamos.is_platform(), llenamos.can_access_restaurant(text) TO llenamos_platform_writer;

-- Ojo: `app.rekey` es un GUC propio y cualquier sesión puede fijarlo con SET; reduce los usos accidentales de las políticas `rekey_*` pero no es una frontera de seguridad
-- (las políticas solo aplican al propietario de las funciones, que la API y el worker no pueden usar).
-- ---- Un borrado cambia el id del cliente en TODAS las tablas de V7 -------------------------------------------------------
-- El id de cliente sale del teléfono sin sal (`customerIdFor`): conservarlo permitiría volver a ligar el historial anónimo con quien reserve de nuevo.
-- El borrado de privacidad lo sustituye por uno aleatorio en una sola transacción (solo worker); el id viejo ya no encuentra nada.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['marketing_consents','marketing_send_log','loyalty_accounts','loyalty_lots','loyalty_redemptions','promotion_customer_uses','bill_promotions','repite_cards','repite_queue'] LOOP
    EXECUTE format('CREATE POLICY rekey_read ON llenamos.%I FOR SELECT TO llenamos_migrator USING(current_setting(''app.rekey'',true)=''on'' AND restaurant_id=nullif(current_setting(''app.restaurant_id'',true),''''))',t);
    EXECUTE format('CREATE POLICY rekey_update ON llenamos.%I FOR UPDATE TO llenamos_migrator USING(current_setting(''app.rekey'',true)=''on'' AND restaurant_id=nullif(current_setting(''app.restaurant_id'',true),'''')) WITH CHECK(current_setting(''app.rekey'',true)=''on'' AND restaurant_id=nullif(current_setting(''app.restaurant_id'',true),''''))',t);
  END LOOP;
END $$;
-- Los avisos, entregas, trabajos y eventos que llevan el id viejo (o un id derivado de él) se reescriben o se borran: con el teléfono se calcula el id
-- viejo y con él `erasure.<id>`, `card.<id>`, `remove.<id>`, el UUID del mensaje de cada campaña… Nada de eso puede quedar como llave del historial.
CREATE POLICY rekey_jobs ON llenamos.jobs FOR DELETE TO llenamos_migrator
  USING(current_setting('app.rekey',true)='on' AND restaurant_id=nullif(current_setting('app.restaurant_id',true),'') AND kind IN ('fidelizacion.procesar_repite','ganchos.reintentar'));
CREATE POLICY rekey_jobs_read ON llenamos.jobs FOR SELECT TO llenamos_migrator
  USING(current_setting('app.rekey',true)='on' AND restaurant_id=nullif(current_setting('app.restaurant_id',true),'') AND kind IN ('fidelizacion.procesar_repite','ganchos.reintentar'));
CREATE POLICY rekey_events ON llenamos.events FOR DELETE TO llenamos_migrator
  USING(current_setting('app.rekey',true)='on' AND restaurant_id=nullif(current_setting('app.restaurant_id',true),'') AND (topic LIKE 'fidelizacion.%' OR topic LIKE 'campanas.%'));
CREATE POLICY rekey_events_read ON llenamos.events FOR SELECT TO llenamos_migrator
  USING(current_setting('app.rekey',true)='on' AND restaurant_id=nullif(current_setting('app.restaurant_id',true),'') AND (topic LIKE 'fidelizacion.%' OR topic LIKE 'campanas.%'));
CREATE POLICY rekey_outbox_read ON llenamos.outbox FOR SELECT TO llenamos_migrator USING(current_setting('app.rekey',true)='on' AND restaurant_id=nullif(current_setting('app.restaurant_id',true),'') AND kind='marketing.campaign_message');
CREATE POLICY rekey_deliveries_read ON llenamos.message_deliveries FOR SELECT TO llenamos_migrator USING(current_setting('app.rekey',true)='on' AND restaurant_id=nullif(current_setting('app.restaurant_id',true),''));
CREATE POLICY rekey_deliveries ON llenamos.message_deliveries FOR UPDATE TO llenamos_migrator
  USING(current_setting('app.rekey',true)='on' AND restaurant_id=nullif(current_setting('app.restaurant_id',true),'')) WITH CHECK(current_setting('app.rekey',true)='on' AND restaurant_id=nullif(current_setting('app.restaurant_id',true),''));
CREATE FUNCTION llenamos.marketing_rekey(rid text,p_old text,p_new text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE n integer:=0; k integer; t text; r record; v_msg uuid;
BEGIN
  PERFORM llenamos.marketing_worker_only(rid);
  -- Las políticas `rekey_*` solo valen mientras esta función corre (la bandera se apaga al salir).
  PERFORM set_config('app.rekey','on',true);
  IF p_new !~ '^[0-9a-f]{20}$' OR p_new=p_old THEN RAISE EXCEPTION 'marketing_invalid'; END IF;
  IF EXISTS(SELECT 1 FROM llenamos.customer_marketing WHERE restaurant_id=rid AND customer_id=p_new) THEN RAISE EXCEPTION 'marketing_invalid'; END IF;
  -- Mensajes de campaña: su id (outbox y entrega) sale de campaña + id viejo; cada uno recibe un UUID aleatorio.
  FOR r IN SELECT campaign_id,message_id FROM llenamos.marketing_campaign_recipients WHERE restaurant_id=rid AND customer_id=p_old AND message_id IS NOT NULL LOOP
    v_msg:=gen_random_uuid();
    UPDATE llenamos.outbox SET id=v_msg WHERE restaurant_id=rid AND id=r.message_id AND kind='marketing.campaign_message';
    UPDATE llenamos.message_deliveries SET id=v_msg WHERE restaurant_id=rid AND id=r.message_id;
    UPDATE llenamos.marketing_campaign_recipients SET message_id=v_msg WHERE restaurant_id=rid AND campaign_id=r.campaign_id AND customer_id=p_old;
    n:=n+1;
  END LOOP;
  -- Trabajos que apuntan a operaciones de Repite de esta persona o llevan su id en el payload; y eventos en vivo con su id como entidad.
  DELETE FROM llenamos.jobs WHERE restaurant_id=rid AND ((kind='fidelizacion.procesar_repite' AND payload->>'operationId' IN (SELECT q.id FROM llenamos.repite_queue q WHERE q.restaurant_id=rid AND q.customer_id=p_old))
    OR (kind='ganchos.reintentar' AND payload->'event'->>'customerId'=p_old));
  GET DIAGNOSTICS k=ROW_COUNT; n:=n+k;
  DELETE FROM llenamos.events WHERE restaurant_id=rid AND (topic LIKE 'fidelizacion.%' OR topic LIKE 'campanas.%') AND position(p_old in coalesce(entity_id,''))>0;
  -- La baja por enlace guarda el UUID del mensaje (derivado del id viejo) como prueba del permiso: también se sustituye.
  UPDATE llenamos.marketing_consents SET evidence_id=gen_random_uuid()::text WHERE restaurant_id=rid AND customer_id=p_old AND policy_version='unsubscribe';
  -- Ids derivados del id viejo en los permisos (`erasure.<id>.<finalidad>`) y en la cola de Repite (`card.<id>`, `remove.<id>`, `missyou.<id>.<fecha>`).
  UPDATE llenamos.marketing_consents SET id=replace(id,p_old,p_new),customer_id=p_new WHERE restaurant_id=rid AND customer_id=p_old;
  GET DIAGNOSTICS k=ROW_COUNT; n:=n+k;
  UPDATE llenamos.repite_queue SET id=replace(id,p_old,p_new),customer_id=p_new WHERE restaurant_id=rid AND customer_id=p_old;
  GET DIAGNOSTICS k=ROW_COUNT; n:=n+k;
  FOREACH t IN ARRAY ARRAY['customer_marketing','marketing_campaign_recipients','marketing_send_log','loyalty_accounts','loyalty_movements','loyalty_lots','loyalty_redemptions','promotion_customer_uses','bill_promotions','repite_cards'] LOOP
    EXECUTE format('UPDATE llenamos.%I SET customer_id=$1 WHERE restaurant_id=$2 AND customer_id=$3',t) USING p_new,rid,p_old;
    GET DIAGNOSTICS k=ROW_COUNT; n:=n+k;
  END LOOP;
  PERFORM set_config('app.rekey','off',true);
  RETURN n;
END $$;
ALTER FUNCTION llenamos.marketing_rekey(text,text,text) OWNER TO llenamos_migrator;
REVOKE ALL ON FUNCTION llenamos.marketing_rekey(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.marketing_rekey(text,text,text) TO llenamos_app;

-- ---- Índices para la poda y el borrado por cliente --------------------------------------------------------------------
CREATE INDEX marketing_unsubscribe_tokens_customer ON llenamos.marketing_unsubscribe_tokens(restaurant_id,customer_id,expires_at);
CREATE INDEX marketing_recipients_customer ON llenamos.marketing_campaign_recipients(restaurant_id,customer_id,at);
CREATE INDEX automation_events_subject ON llenamos.automation_events(restaurant_id,subject);
CREATE INDEX recommendations_subject ON llenamos.recommendations(restaurant_id,subject);
CREATE INDEX bill_promotions_customer ON llenamos.bill_promotions(restaurant_id,customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX loyalty_redemptions_customer ON llenamos.loyalty_redemptions(restaurant_id,customer_id);
CREATE INDEX marketing_consents_customer_only ON llenamos.marketing_consents(restaurant_id,customer_id);

-- ---- Relleno de lo que ya existía antes de esta migración (idempotente) -------------------------------------------------
-- BACKFILL-INICIO
INSERT INTO llenamos.customer_marketing(restaurant_id,customer_id,name,phone,email,language,visits,no_shows,last_visit_at,spent_cents,tags)
SELECT c.restaurant_id,c.id,left(coalesce(c.data->>'name',''),120),left(nullif(c.data->>'phone',''),30),left(nullif(c.data->>'email',''),254),
  CASE WHEN c.data->>'language' IN ('es','ca','en') THEN c.data->>'language' ELSE 'es' END,
  CASE WHEN c.data->>'visits' ~ '^[0-9]+$' THEN (c.data->>'visits')::integer ELSE 0 END,
  CASE WHEN c.data->>'noShows' ~ '^[0-9]+$' THEN (c.data->>'noShows')::integer ELSE 0 END,
  CASE WHEN c.data->>'lastVisitAt' ~ '^[0-9]+$' THEN to_timestamp((c.data->>'lastVisitAt')::bigint/1000.0) ELSE NULL END,
  CASE WHEN c.data->>'spentCents' ~ '^[0-9]+$' THEN (c.data->>'spentCents')::bigint ELSE 0 END,
  CASE WHEN jsonb_typeof(c.data->'tags')='array' THEN ARRAY(SELECT jsonb_array_elements_text(c.data->'tags')) ELSE '{}' END
FROM llenamos.customers c
WHERE coalesce(c.data->>'privacyRedacted','false')<>'true'
ON CONFLICT(restaurant_id,customer_id) DO NOTHING;
INSERT INTO llenamos.marketing_consents(restaurant_id,id,customer_id,purpose,status,policy_version,at,source,evidence_id)
SELECT c.restaurant_id,c.id,c.data->>'customerId',c.data->>'purpose',c.data->>'status',left(coalesce(c.data->>'policyVersion','x'),80),
  CASE WHEN c.data->>'at' ~ '^[0-9]+$' THEN least(to_timestamp((c.data->>'at')::bigint/1000.0),clock_timestamp()) ELSE c.created_at END,
  c.data->>'source',left(coalesce(c.data->>'evidenceId','x'),128)
FROM llenamos.consents c
WHERE c.data->>'purpose' IN ('marketing_email','marketing_whatsapp','digital_receipt') AND c.data->>'status' IN ('granted','withdrawn')
  AND c.data->>'customerId' ~ '^[0-9a-f]{20}$' AND c.data->>'source' IN ('public','staff','import')
ON CONFLICT DO NOTHING;
-- BACKFILL-FIN

-- ---- Bajas pendientes en Repite ------------------------------------------------------------------------------------------
-- Cuando un borrado de privacidad da por retirada EN LOCAL una tarjeta que Repite no ha podido retirar, el restaurante no puede hacer nada más: queda aquí,
-- con el comercio y la tarjeta (ids opacos de Repite, no identifican a la persona en nuestra base), para que plataforma pida la baja y la marque resuelta.
CREATE TABLE llenamos.repite_pending_removals (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  merchant_id varchar(60) NOT NULL,
  card_id varchar(100) NOT NULL,
  reason text NOT NULL CHECK(reason IN ('repite_no_configurado','retirada_fallida')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text,
  PRIMARY KEY(restaurant_id,id)
);
CREATE INDEX repite_pending_removals_open ON llenamos.repite_pending_removals(created_at) WHERE resolved_at IS NULL;
ALTER TABLE llenamos.repite_pending_removals ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.repite_pending_removals FORCE ROW LEVEL SECURITY;
ALTER TABLE llenamos.repite_pending_removals OWNER TO llenamos_migrator;
CREATE POLICY tenant_access ON llenamos.repite_pending_removals USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id));
CREATE POLICY platform_queue ON llenamos.repite_pending_removals TO llenamos_migrator USING(llenamos.is_platform()) WITH CHECK(llenamos.is_platform());
GRANT SELECT ON llenamos.repite_pending_removals TO llenamos_app;
-- La baja se registra con esta función (solo worker): toma el comercio y la tarjeta de la propia ficha de la tarjeta, no de lo que diga quien llama.
CREATE FUNCTION llenamos.repite_register_removal(rid text,p_customer text,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE n integer;
BEGIN
  PERFORM llenamos.marketing_worker_only(rid);
  INSERT INTO llenamos.repite_pending_removals(restaurant_id,merchant_id,card_id,reason)
    SELECT c.restaurant_id,c.merchant_id,c.card_id,p_reason FROM llenamos.repite_cards c WHERE c.restaurant_id=rid AND c.customer_id=p_customer AND c.status='active';
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n=1;
END $$;
CREATE POLICY register_cards_read ON llenamos.repite_cards FOR SELECT TO llenamos_migrator USING(restaurant_id=nullif(current_setting('app.restaurant_id',true),''));
CREATE POLICY register_ctx ON llenamos.repite_pending_removals FOR INSERT TO llenamos_migrator WITH CHECK(restaurant_id=nullif(current_setting('app.restaurant_id',true),''));
CREATE POLICY register_read ON llenamos.repite_pending_removals FOR SELECT TO llenamos_migrator USING(restaurant_id=nullif(current_setting('app.restaurant_id',true),''));
CREATE FUNCTION llenamos.repite_removals_list() RETURNS TABLE(restaurant_id text,id uuid,merchant_id text,card_id text,reason text,created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
  PERFORM llenamos.assert_platform_actor();
  RETURN QUERY SELECT p.restaurant_id::text,p.id,p.merchant_id::text,p.card_id::text,p.reason,p.created_at FROM llenamos.repite_pending_removals p WHERE p.resolved_at IS NULL ORDER BY p.created_at,p.id LIMIT 500;
END $$;
CREATE FUNCTION llenamos.repite_removal_resolve(p_rid text,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE n integer;
BEGIN
  PERFORM llenamos.assert_platform_actor();
  UPDATE llenamos.repite_pending_removals SET resolved_at=now(),resolved_by=llenamos.actor_uid() WHERE restaurant_id=p_rid AND id=p_id AND resolved_at IS NULL;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n=1;
END $$;
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='llenamos' AND p.proname IN ('repite_removals_list','repite_removal_resolve','repite_register_removal') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO llenamos_migrator',f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO llenamos_app',f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION llenamos.assert_platform_actor() TO llenamos_migrator;
