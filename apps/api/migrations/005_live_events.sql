-- Tiempo real: orden de lectura seguro y aviso de despertar para las suscripciones SSE.
-- Los id de identidad se confirman fuera de orden entre transacciones concurrentes; leer por id
-- puede saltarse un evento. `tx` guarda la transacción del hecho y solo se entregan eventos de
-- transacciones anteriores al horizonte del snapshot (todas ya cerradas), así no se pierde ninguno.
ALTER TABLE llenamos.events ADD COLUMN tx xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX events_tx ON llenamos.events(restaurant_id,tx);
CREATE INDEX events_topic_tx ON llenamos.events(restaurant_id,topic,tx);

CREATE FUNCTION llenamos.notify_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Solo el restaurante: despierta a los suscriptores, que releen con su propia identidad y RLS.
  PERFORM pg_notify('llenamos_events',NEW.restaurant_id);
  RETURN NULL;
END $$;
ALTER FUNCTION llenamos.notify_event() OWNER TO llenamos_migrator;
CREATE TRIGGER events_notify AFTER INSERT ON llenamos.events FOR EACH ROW EXECUTE FUNCTION llenamos.notify_event();
