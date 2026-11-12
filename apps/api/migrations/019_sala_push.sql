-- Avisos push de tareas de sala vencidas y sin dueño (W2). Una fila por tarea, hora de vencimiento y suscripción:
-- el ID es un hash, así que repetir el trabajo no duplica el envío. Sin datos personales (la suscripción es un hash
-- del endpoint y el texto del aviso solo se guarda en el modo de captura de pruebas).
CREATE TABLE llenamos.sala_push_deliveries (
  restaurant_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  id char(64) NOT NULL,
  task_id varchar(128) NOT NULL,
  subscription_id char(64) NOT NULL,
  status text NOT NULL CHECK(status IN ('sending','sent','captured','failed','expired','cancelled')),
  lease uuid NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  retry_at bigint NOT NULL,
  error text,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE INDEX sala_push_deliveries_age ON llenamos.sala_push_deliveries(restaurant_id,location_id,updated_at);
ALTER TABLE llenamos.sala_push_deliveries OWNER TO llenamos_migrator;
ALTER TABLE llenamos.sala_push_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.sala_push_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON llenamos.sala_push_deliveries USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id));
-- Solo la usa el worker, pero su login es miembro de `llenamos_app` (006) y las demás tablas de sala se conceden igual a ese rol;
-- la API no la lee ni la escribe.
GRANT SELECT,INSERT,UPDATE ON llenamos.sala_push_deliveries TO llenamos_app;
-- Las entregas antiguas se retiran (el worker, que es quien las crea y las cierra).
GRANT DELETE ON llenamos.sala_push_deliveries TO llenamos_worker;
