-- W1 · claves de los proveedores del propio restaurante (Stripe, WhatsApp, correo, fiscal, Repite).
-- Hasta ahora solo el operador de plataforma podía escribir la bóveda (`platform_integrations`). El propietario
-- la gestiona desde su configuración con estas dos funciones; el cifrado lo hace la API, la base solo guarda texto
-- sellado. Cada función comprueba en SQL que quien llama es propietario activo del restaurante (`billing_member`).
-- Las políticas solo abren la fila del restaurante que la función fija en `app.owner_vault` dentro de su transacción.

-- ¿El actor es propietario activo de este restaurante? (misma comprobación que `billing_member(rid,true)`, como booleano)
CREATE FUNCTION llenamos.vault_owner_ok(p_rid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT NOT llenamos.is_platform() AND llenamos.actor_uid() IS NOT NULL AND EXISTS(
    SELECT 1 FROM llenamos.memberships m JOIN llenamos.identities i ON i.uid=m.uid
    WHERE m.restaurant_id=p_rid AND m.uid=llenamos.actor_uid() AND m.active AND m.role='owner' AND NOT i.locked AND NOT i.disabled AND NOT i.platform_operator)
$$;
ALTER FUNCTION llenamos.vault_owner_ok(text) OWNER TO llenamos_migrator;
REVOKE ALL ON FUNCTION llenamos.vault_owner_ok(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.vault_owner_ok(text) TO llenamos_migrator;

-- Solo las funciones de abajo leen la bóveda como migrador. La política exige además que el actor sea propietario del
-- restaurante, así que aunque alguien fije `app.owner_vault` a mano, una función futura del migrador no queda abierta
-- para quien no es propietario. (`platform_restaurants` ya tiene la política de custodia del migrador desde 003.)
CREATE POLICY owner_vault ON llenamos.integration_secrets TO llenamos_migrator
  USING(restaurant_id=nullif(current_setting('app.owner_vault',true),'') AND llenamos.vault_owner_ok(restaurant_id))
  WITH CHECK(restaurant_id=nullif(current_setting('app.owner_vault',true),'') AND llenamos.vault_owner_ok(restaurant_id));
CREATE POLICY owner_vault ON llenamos.integration_webhook_secrets TO llenamos_migrator
  USING(restaurant_id=nullif(current_setting('app.owner_vault',true),'') AND llenamos.vault_owner_ok(restaurant_id))
  WITH CHECK(restaurant_id=nullif(current_setting('app.owner_vault',true),'') AND llenamos.vault_owner_ok(restaurant_id));

-- Texto sellado actual (o NULL) bloqueando la fila, para que dos guardados seguidos no se pisen.
CREATE FUNCTION llenamos.restaurant_vault_open(p_rid text,p_write boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE c text;
BEGIN
 PERFORM llenamos.billing_member(p_rid,true);
 PERFORM set_config('app.owner_vault',p_rid,true);
 IF p_write THEN PERFORM 1 FROM llenamos.restaurants WHERE id=p_rid FOR UPDATE; END IF;
 SELECT i.ciphertext INTO c FROM llenamos.integration_secrets i WHERE i.restaurant_id=p_rid;
 RETURN c;
END $$;

-- Guarda el texto sellado completo, el estado derivado y los secretos de firma de webhooks (por proveedor, NULL = borrar).
CREATE FUNCTION llenamos.restaurant_vault_save(p_rid text,p_ciphertext text,p_status jsonb,p_webhooks jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE p text; w text;
BEGIN
 PERFORM llenamos.billing_member(p_rid,true);
 PERFORM set_config('app.owner_vault',p_rid,true);
 IF p_ciphertext IS NULL THEN DELETE FROM llenamos.integration_secrets WHERE restaurant_id=p_rid;
 ELSE INSERT INTO llenamos.integration_secrets(restaurant_id,ciphertext) VALUES(p_rid,p_ciphertext)
   ON CONFLICT(restaurant_id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=now(); END IF;
 UPDATE llenamos.platform_restaurants SET integration_status=p_status WHERE restaurant_id=p_rid;
 -- Sin ficha de plataforma la parte pública nunca vería el cambio: mejor fallar que guardar a medias.
 IF NOT FOUND THEN RAISE EXCEPTION 'restaurant_missing' USING ERRCODE='P0002'; END IF;
 FOR p IN SELECT jsonb_object_keys(p_webhooks) LOOP
   IF p NOT IN ('stripe','whatsapp') THEN RAISE EXCEPTION 'invalid_provider' USING ERRCODE='22023'; END IF;
   w:=p_webhooks->>p;
   IF w IS NULL THEN DELETE FROM llenamos.integration_webhook_secrets WHERE restaurant_id=p_rid AND provider=p;
   ELSE INSERT INTO llenamos.integration_webhook_secrets(restaurant_id,provider,ciphertext) VALUES(p_rid,p,w)
     ON CONFLICT(restaurant_id,provider) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=now(); END IF;
 END LOOP;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='llenamos' AND p.proname IN ('restaurant_vault_open','restaurant_vault_save') LOOP
  EXECUTE format('ALTER FUNCTION %s OWNER TO llenamos_migrator',f);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO llenamos_app',f);
 END LOOP;
END $$;

-- Equipo del restaurante: la tabla `memberships` solo deja ver la fila propia, así que el listado va por una función
-- que exige ser miembro activo (no operador de plataforma) y devuelve solo lo que ya veían los miembros en Firestore.
CREATE FUNCTION llenamos.restaurant_members(p_rid text) RETURNS TABLE(uid text,display_name varchar,email varchar,role text,location_ids text[],active boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
BEGIN
 IF llenamos.is_platform() OR llenamos.actor_uid() IS NULL OR NOT EXISTS(
   SELECT 1 FROM llenamos.memberships m JOIN llenamos.identities i ON i.uid=m.uid
   WHERE m.restaurant_id=p_rid AND m.uid=llenamos.actor_uid() AND m.active AND NOT i.locked AND NOT i.disabled AND NOT i.platform_operator) THEN
  RAISE EXCEPTION 'members_forbidden' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT m.uid,m.display_name,m.email,m.role,m.location_ids,m.active FROM llenamos.memberships m WHERE m.restaurant_id=p_rid ORDER BY m.display_name,m.uid LIMIT 500;
END $$;
ALTER FUNCTION llenamos.restaurant_members(text) OWNER TO llenamos_migrator;
REVOKE ALL ON FUNCTION llenamos.restaurant_members(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.restaurant_members(text) TO llenamos_app;

-- Avisos de una reserva: sin índice habría que recorrer todos los resultados del restaurante.
CREATE INDEX message_deliveries_reservation ON llenamos.message_deliveries(restaurant_id,(context->>'reservationId'),created_at DESC) WHERE context->>'reservationId' IS NOT NULL;

-- Índices de la bandeja de avisos: la cola guarda 30 días de terminados de todos los restaurantes y los en cuarentena para
-- siempre, así que filtrar por estado sin índice recorrería toda la tabla en cada lectura (cada 10 s por bandeja abierta).
CREATE INDEX outbox_notices_recent ON llenamos.outbox(restaurant_id,occurred_at DESC,id)
  WHERE kind='mensaje.enviar' AND status IN ('pending','leased','failed','quarantined');
CREATE INDEX outbox_notices_reservation ON llenamos.outbox(restaurant_id,(payload->>'reservationId'),occurred_at DESC)
  WHERE kind='mensaje.enviar' AND status IN ('pending','leased','failed','quarantined');

-- Señal de reserva: solo hay Stripe utilizable cuando el estado es `configured`. Con `adapter_pending` (clave guardada,
-- sin conector) la reserva pública no pide señal y `iniciarPagoSenal` responde `not_configured`, como antes de guardar la clave.
CREATE OR REPLACE FUNCTION llenamos.reservas_public_resolve(p_rid text,p_slug text,p_location text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT jsonb_build_object('restaurantId',r.id,'name',r.name,'slug',r.slug,'timezone',r.timezone,'locale',r.locale,'plan',r.plan,
    'activeModules',to_jsonb(r.active_modules),'entitlementVersion',r.entitlement_version,'moduleOverrides',r.module_overrides,
    'accessOk',(r.entitlement_version IS NULL OR r.access_valid_until>now()),
    'accessValidUntil',CASE WHEN r.entitlement_version IS NULL THEN NULL ELSE (extract(epoch FROM r.access_valid_until)*1000)::bigint END,
    'locationId',l.id,'locationName',l.name,
    'stripe',coalesce(p.integration_status->'stripe'->>'status'='configured',false))
  FROM llenamos.restaurants r
  LEFT JOIN llenamos.locations l ON l.restaurant_id=r.id AND l.id=p_location
  LEFT JOIN llenamos.platform_restaurants p ON p.restaurant_id=r.id
  WHERE (p_rid IS NULL OR r.id=p_rid) AND (p_slug IS NULL OR r.slug=p_slug) AND (p_rid IS NOT NULL OR p_slug IS NOT NULL)
$$;
