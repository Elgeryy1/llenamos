-- Avisos a clientes: ningún token de enlace queda en claro en la cola cuando el elemento termina.
-- El worker ya los borra al registrar un resultado definitivo; este disparador cubre además las salidas
-- que no pasan por el manejador (cuarentena por lease agotado, baja o anulación). Ejecutar con el rol bootstrap.
CREATE FUNCTION llenamos.outbox_scrub_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payload ? 'data' THEN
    NEW.payload := NEW.payload #- '{data,manageUrl}' #- '{data,offerUrl}' #- '{data,paymentUrl}' #- '{data,trackUrl}';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION llenamos.outbox_scrub_links() OWNER TO llenamos_migrator;
CREATE TRIGGER outbox_scrub_links BEFORE UPDATE OF status ON llenamos.outbox
  FOR EACH ROW WHEN (NEW.status IN ('done','failed','quarantined','cancelled') AND OLD.status IS DISTINCT FROM NEW.status AND NEW.kind IN ('mensaje.enviar','aviso.mensaje','aviso.recogida'))
  EXECUTE FUNCTION llenamos.outbox_scrub_links();
-- Filas que ya terminaron antes de existir el disparador (esta sentencia no cambia `status`, no lo dispara).
UPDATE llenamos.outbox SET payload=payload #- '{data,manageUrl}' #- '{data,offerUrl}' #- '{data,paymentUrl}' #- '{data,trackUrl}'
  WHERE status IN ('done','failed','quarantined','cancelled') AND kind IN ('mensaje.enviar','aviso.mensaje','aviso.recogida') AND payload ? 'data'
    AND (payload->'data' ? 'manageUrl' OR payload->'data' ? 'offerUrl' OR payload->'data' ? 'paymentUrl' OR payload->'data' ? 'trackUrl');

-- Privacidad de reservas: el worker (no la API) anonimiza los orígenes de marketing y el libro de permisos de una
-- persona, solo en las columnas que toca, y borra su ficha de cliente. La API sigue sin poder hacerlo.
GRANT UPDATE (click_ids,ad_id,referrer_host,campaign,campaign_id,content,term,data) ON llenamos.reservation_origins TO llenamos_worker;
GRANT UPDATE (data) ON llenamos.consents TO llenamos_worker;
GRANT DELETE ON llenamos.customers TO llenamos_worker;

-- Localizar a una persona en sala y caja sin recorrer las tablas (solicitudes de privacidad).
CREATE INDEX sala_takeaways_customer ON llenamos.sala_takeaways(restaurant_id,(doc->>'customerId'));
CREATE INDEX sala_sessions_customer ON llenamos.sala_table_sessions(restaurant_id,(doc->>'customerId'));
CREATE INDEX pos_bills_customer ON llenamos.pos_bills(restaurant_id,(data->>'customerId')) WHERE data->>'customerId' IS NOT NULL;

-- Los avisos de reserva con enlace solo los leen owner y manager por HTTP. El worker sí debe verlos (limpiarlos al
-- terminar, anularlos en un borrado de privacidad), pero actúa con `app.actor_uid='worker'`, no sin actor: la política
-- original lo dejaba fuera sin avisar (el UPDATE no encontraba filas). Se reconoce por su rol.
DROP POLICY reservas_notice_roles ON llenamos.outbox;
CREATE POLICY reservas_notice_roles ON llenamos.outbox AS RESTRICTIVE FOR SELECT TO llenamos_app
  USING(kind<>'aviso.mensaje' OR llenamos.actor_uid() IS NULL OR pg_has_role(current_user,'llenamos_worker','member') OR occurred_at=now() OR EXISTS(SELECT 1 FROM llenamos.memberships m
    WHERE m.restaurant_id=outbox.restaurant_id AND m.uid=llenamos.actor_uid() AND m.active AND m.role IN ('owner','manager')));
