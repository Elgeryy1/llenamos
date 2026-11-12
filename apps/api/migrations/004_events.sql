-- Eventos de dominio para tiempo real. Se escriben en la misma transacción que el hecho;
-- el servidor de suscripciones los entrega por cursor (id) a quien pueda ver ese restaurante.
CREATE TABLE llenamos.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  location_id varchar(128),
  topic varchar(120) NOT NULL CHECK(topic ~ '^[a-z][a-z0-9_.-]*$'),
  entity_id varchar(256),
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_cursor ON llenamos.events(restaurant_id,id);
CREATE INDEX events_topic ON llenamos.events(restaurant_id,topic,id);
ALTER TABLE llenamos.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON llenamos.events USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id));
ALTER TABLE llenamos.events OWNER TO llenamos_migrator;
GRANT SELECT,INSERT ON llenamos.events TO llenamos_app;
