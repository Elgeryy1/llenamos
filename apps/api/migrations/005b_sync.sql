-- Sincronización sin conexión: dispositivos, flujos ordenados, recibos idempotentes y resoluciones.
-- Sustituye a syncDevices/syncStreams/syncReceipts/syncResolutions de Firestore. Nunca se lee con
-- cliente: solo la API, dentro de la transacción del restaurante (RLS por restaurante).
CREATE TABLE llenamos.sync_devices (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  location_id varchar(128) NOT NULL,
  device_id varchar(100) NOT NULL CHECK(device_id ~ '^[a-zA-Z0-9_-]{16,100}$'),
  uid text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,location_id,device_id)
);
CREATE TABLE llenamos.sync_streams (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  stream_key char(64) NOT NULL CHECK(stream_key ~ '^[a-f0-9]{64}$'),
  location_id varchar(128) NOT NULL,
  device_id varchar(100) NOT NULL,
  uid text NOT NULL,
  last_settled_sequence integer NOT NULL DEFAULT 0 CHECK(last_settled_sequence>=0),
  blocked_command_id varchar(100),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,stream_key)
);
CREATE TABLE llenamos.sync_receipts (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  receipt_key char(64) NOT NULL CHECK(receipt_key ~ '^[a-f0-9]{64}$'),
  command_id varchar(100) NOT NULL,
  stream_key char(64) NOT NULL,
  sequence integer NOT NULL CHECK(sequence>0),
  fingerprint char(64) NOT NULL,
  operation varchar(60) NOT NULL,
  result jsonb NOT NULL,
  recorded_at_ms bigint NOT NULL,
  updated_by text NOT NULL,
  -- Lo marca la exportación/borrado de privacidad: el recibo no se devuelve ni se reejecuta.
  privacy_redacted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,receipt_key)
);
CREATE INDEX sync_receipts_stream ON llenamos.sync_receipts(restaurant_id,stream_key,sequence);
CREATE TABLE llenamos.sync_resolutions (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  receipt_key char(64) NOT NULL,
  command_id varchar(100) NOT NULL,
  original jsonb,
  reason varchar(200) NOT NULL,
  request_id varchar(100) NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,receipt_key)
);
-- Auditoría de la sincronización (sustituye a las entradas `activity` sync.* de Firestore): quién descartó
-- una intención y por qué, y qué operaciones se aplicaron. Sin datos personales más allá del nombre del autor.
CREATE TABLE llenamos.sync_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  location_id varchar(128) NOT NULL,
  action varchar(80) NOT NULL CHECK(action ~ '^sync\.[A-Za-z.]+$'),
  summary varchar(200) NOT NULL,
  actor_uid text NOT NULL,
  actor_name varchar(80) NOT NULL,
  command_id varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_activity_recent ON llenamos.sync_activity(restaurant_id,id DESC);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sync_devices','sync_streams','sync_receipts','sync_resolutions','sync_activity'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_access ON llenamos.%I USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id))',t);
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON llenamos.sync_devices,llenamos.sync_streams,llenamos.sync_receipts TO llenamos_app;
GRANT SELECT,INSERT ON llenamos.sync_resolutions,llenamos.sync_activity TO llenamos_app;
GRANT USAGE ON SEQUENCE llenamos.sync_activity_id_seq TO llenamos_app;
