-- Fidelización, promociones y Repite (V7). Depende de 011_clientes_base.sql (customer_marketing, marketing_consents).
-- Sin FK a clientes ni a cuentas de caja: esas tablas las portan V3 y V5; aquí se guardan los identificadores.

-- Ajustes del programa de puntos: JSON validado por LoyaltySettingsSchema (core) antes de escribir.
CREATE TABLE llenamos.loyalty_settings (
  restaurant_id varchar(128) PRIMARY KEY REFERENCES llenamos.restaurants(id),
  settings jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE llenamos.loyalty_rewards (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(128) NOT NULL,
  name varchar(80) NOT NULL,
  points_cost integer NOT NULL CHECK(points_cost BETWEEN 1 AND 1000000),
  kind text NOT NULL CHECK(kind IN ('amount','item')),
  value_cents bigint NOT NULL CHECK(value_cents>0),
  item_id varchar(128),
  active boolean NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,id),
  CHECK((kind='item') = (item_id IS NOT NULL))
);
CREATE TABLE llenamos.loyalty_accounts (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  customer_id char(20) NOT NULL CHECK(customer_id ~ '^[0-9a-f]{20}$'),
  status text NOT NULL CHECK(status IN ('active','closed')),
  balance bigint NOT NULL DEFAULT 0 CHECK(balance>=0),
  earned bigint NOT NULL DEFAULT 0,
  redeemed bigint NOT NULL DEFAULT 0,
  expired bigint NOT NULL DEFAULT 0,
  terms_version varchar(40) NOT NULL,
  enrolled_at bigint NOT NULL,
  enrolled_by text NOT NULL,
  -- Reloj monótono del libro de este cliente: cada movimiento nuevo lleva `at` mayor que el anterior.
  last_movement_ms bigint NOT NULL DEFAULT -1,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  PRIMARY KEY(restaurant_id,customer_id)
);
-- Libro inmutable: sin UPDATE ni DELETE para la API. Saldo, lotes y libro se escriben en la misma transacción.
CREATE TABLE llenamos.loyalty_movements (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(200) NOT NULL,
  customer_id char(20) NOT NULL,
  kind text NOT NULL CHECK(kind IN ('earn','redeem','redeem_reversal','earn_reversal','adjust','expire')),
  points integer NOT NULL,
  balance_after bigint NOT NULL CHECK(balance_after>=0),
  at_ms bigint NOT NULL,
  expires_at_ms bigint,
  location_id varchar(128),
  bill_id varchar(128),
  redemption_id varchar(128),
  earn_movement_id varchar(200),
  reason varchar(200),
  by_uid text,
  PRIMARY KEY(restaurant_id,id)
);
CREATE INDEX loyalty_movements_customer ON llenamos.loyalty_movements(restaurant_id,customer_id,at_ms DESC,id DESC);
-- Tandas de puntos: proyección del libro con lo que queda de cada tanda positiva. Solo las vivas importan.
CREATE TABLE llenamos.loyalty_lots (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  movement_id varchar(200) NOT NULL,
  customer_id char(20) NOT NULL,
  at_ms bigint NOT NULL,
  expires_at_ms bigint,
  initial integer NOT NULL CHECK(initial>0),
  remaining integer NOT NULL CHECK(remaining>=0 AND remaining<=initial),
  PRIMARY KEY(restaurant_id,movement_id)
);
CREATE INDEX loyalty_lots_live ON llenamos.loyalty_lots(restaurant_id,customer_id) WHERE remaining>0;
CREATE INDEX loyalty_lots_expiry ON llenamos.loyalty_lots(restaurant_id,expires_at_ms,movement_id) WHERE remaining>0 AND expires_at_ms IS NOT NULL;
CREATE TABLE llenamos.loyalty_redemptions (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(128) NOT NULL,
  customer_id char(20) NOT NULL,
  reward_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  bill_id varchar(128) NOT NULL,
  points integer NOT NULL CHECK(points>0),
  discount_cents bigint NOT NULL CHECK(discount_cents>0),
  status text NOT NULL CHECK(status IN ('applied','reversed','settled')),
  at_ms bigint NOT NULL,
  by_uid text NOT NULL,
  PRIMARY KEY(restaurant_id,id)
);
CREATE INDEX loyalty_redemptions_bill ON llenamos.loyalty_redemptions(restaurant_id,location_id,bill_id);

-- Promociones: la definición validada por PromotionInputSchema va en JSON; estado, usos y revisión, en columnas.
CREATE TABLE llenamos.promotions (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(128) NOT NULL,
  definition jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('draft','active','paused','archived')),
  uses integer NOT NULL DEFAULT 0 CHECK(uses>=0),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,id)
);
CREATE INDEX promotions_status ON llenamos.promotions(restaurant_id,status,id);
CREATE TABLE llenamos.promotion_customer_uses (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  promotion_id varchar(128) NOT NULL,
  customer_id char(20) NOT NULL,
  uses integer NOT NULL CHECK(uses>=0),
  PRIMARY KEY(restaurant_id,promotion_id,customer_id)
);
CREATE TABLE llenamos.bill_promotions (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  location_id varchar(128) NOT NULL,
  bill_id varchar(128) NOT NULL,
  promotion_id varchar(128) NOT NULL,
  customer_id char(20),
  discount_cents bigint NOT NULL CHECK(discount_cents>0),
  adjustment_ids text[] NOT NULL,
  status text NOT NULL CHECK(status IN ('applied','removed')),
  at_ms bigint NOT NULL,
  by_uid text NOT NULL,
  PRIMARY KEY(restaurant_id,location_id,bill_id)
);

-- Repite: ajustes (merchant_id solo lo cambia LogiQD con repite_link), enlace con tarjetas y cola propia.
CREATE TABLE llenamos.repite_settings (
  restaurant_id varchar(128) PRIMARY KEY REFERENCES llenamos.restaurants(id),
  merchant_id varchar(60) CHECK(merchant_id ~ '^[a-z0-9-]{2,60}$'),
  enabled boolean NOT NULL DEFAULT false,
  stamp_on text NOT NULL DEFAULT 'seated' CHECK(stamp_on IN ('seated','paid','both')),
  auto_create_card boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE llenamos.repite_cards (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  customer_id char(20) NOT NULL CHECK(customer_id ~ '^[0-9a-f]{20}$'),
  merchant_id varchar(60) NOT NULL,
  card_id varchar(100) NOT NULL,
  external_ref varchar(64) NOT NULL,
  status text NOT NULL CHECK(status IN ('active','removed')),
  created_at_ms bigint NOT NULL,
  PRIMARY KEY(restaurant_id,customer_id)
);
CREATE INDEX repite_cards_status ON llenamos.repite_cards(restaurant_id,status);
-- Cola de operaciones hacia Repite (core: RepiteOperation). Tiene estados propios (not_configured, skipped,
-- duplicate…) que no caben en llenamos.outbox; cada operación avisa al worker con un trabajo en llenamos.jobs.
CREATE TABLE llenamos.repite_queue (
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  id varchar(300) NOT NULL,
  kind text NOT NULL CHECK(kind IN ('create_card','add_stamp','we_miss_you','remove_card')),
  customer_id char(20) NOT NULL,
  merchant_id varchar(60) NOT NULL,
  visit_key varchar(300),
  trigger text CHECK(trigger IN ('seated','paid','manual')),
  occurred_at_ms bigint NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','done','duplicate','failed','not_configured','skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at_ms bigint,
  lease_until_ms bigint,
  lease_owner uuid,
  external_ref varchar(64),
  last_error jsonb,
  result jsonb,
  PRIMARY KEY(restaurant_id,id)
);
CREATE INDEX repite_queue_due ON llenamos.repite_queue(restaurant_id,next_attempt_at_ms,id) WHERE status IN ('queued','leased');
CREATE INDEX repite_queue_customer ON llenamos.repite_queue(restaurant_id,customer_id,kind);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['loyalty_settings','loyalty_rewards','loyalty_accounts','loyalty_movements','loyalty_lots','loyalty_redemptions','promotions','promotion_customer_uses','bill_promotions','repite_settings','repite_cards','repite_queue'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_access ON llenamos.%I USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id))',t);
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON llenamos.loyalty_settings,llenamos.loyalty_rewards,llenamos.loyalty_accounts,llenamos.loyalty_lots,llenamos.loyalty_redemptions,
  llenamos.promotions,llenamos.promotion_customer_uses,llenamos.bill_promotions,llenamos.repite_settings,llenamos.repite_cards,llenamos.repite_queue TO llenamos_app;
GRANT SELECT,INSERT ON llenamos.loyalty_movements TO llenamos_app;

-- vincularRepite: LogiQD no entra en el restaurante (RLS lo impide a la plataforma). Este procedimiento, propiedad
-- del rol escritor de plataforma, solo toca repite_settings.merchant_id, lee si hay tarjetas activas y deja auditoría.
CREATE TABLE llenamos.repite_link_receipts (
  actor_uid text NOT NULL,
  request_key varchar(256) NOT NULL,
  request_hash char(64) NOT NULL,
  restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_uid,request_key)
);
ALTER TABLE llenamos.repite_link_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE llenamos.repite_link_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE llenamos.repite_link_receipts OWNER TO llenamos_migrator;
CREATE POLICY platform_writer ON llenamos.repite_link_receipts TO llenamos_platform_writer USING(llenamos.is_platform()) WITH CHECK(llenamos.is_platform());
CREATE POLICY platform_writer_link ON llenamos.repite_settings TO llenamos_platform_writer USING(llenamos.is_platform()) WITH CHECK(llenamos.is_platform());
CREATE POLICY platform_writer_cards ON llenamos.repite_cards FOR SELECT TO llenamos_platform_writer USING(llenamos.is_platform());
GRANT SELECT,INSERT ON llenamos.repite_link_receipts TO llenamos_platform_writer;
GRANT SELECT,INSERT,UPDATE ON llenamos.repite_settings TO llenamos_platform_writer;
GRANT SELECT ON llenamos.repite_cards TO llenamos_platform_writer;

CREATE FUNCTION llenamos.repite_link(p_rid text,p_merchant text,p_reason text,p_key text,p_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE current_merchant text; rev integer; prev char(64);
BEGIN
 PERFORM llenamos.assert_platform_actor();
 IF (p_merchant IS NOT NULL AND p_merchant !~ '^[a-z0-9-]{2,60}$') OR length(p_reason) NOT BETWEEN 1 AND 200 OR length(p_key) NOT BETWEEN 1 AND 256 THEN
  RAISE EXCEPTION 'invalid_repite_link' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(llenamos.actor_uid()||':repite_link:'||p_key,0));
 SELECT request_hash INTO prev FROM llenamos.repite_link_receipts WHERE actor_uid=llenamos.actor_uid() AND request_key=p_key;
 IF FOUND THEN
  IF prev<>p_hash THEN RAISE EXCEPTION 'request_conflict' USING ERRCODE='23505'; END IF;
  RETURN;
 END IF;
 IF NOT EXISTS(SELECT FROM llenamos.platform_restaurants WHERE restaurant_id=p_rid) THEN RAISE EXCEPTION 'restaurant_missing' USING ERRCODE='P0002'; END IF;
 PERFORM id FROM llenamos.restaurants WHERE id=p_rid FOR UPDATE;
 INSERT INTO llenamos.repite_settings(restaurant_id,updated_by) VALUES(p_rid,llenamos.actor_uid()) ON CONFLICT(restaurant_id) DO NOTHING;
 SELECT merchant_id,revision INTO current_merchant,rev FROM llenamos.repite_settings WHERE restaurant_id=p_rid FOR UPDATE;
 IF current_merchant IS DISTINCT FROM p_merchant AND EXISTS(SELECT FROM llenamos.repite_cards WHERE restaurant_id=p_rid AND status='active') THEN
  RAISE EXCEPTION 'repite_cards_active' USING ERRCODE='P0001';
 END IF;
 UPDATE llenamos.repite_settings SET merchant_id=p_merchant,revision=rev+1,updated_by=llenamos.actor_uid(),updated_at=now() WHERE restaurant_id=p_rid;
 INSERT INTO llenamos.platform_audit(actor_uid,restaurant_id,action,reason,revision) VALUES(llenamos.actor_uid(),p_rid,'repite.linked',p_reason,rev+1);
 INSERT INTO llenamos.events(restaurant_id,topic,entity_id) VALUES(p_rid,'fidelizacion.repite','settings');
 INSERT INTO llenamos.repite_link_receipts(actor_uid,request_key,request_hash,restaurant_id) VALUES(llenamos.actor_uid(),p_key,p_hash,p_rid);
END $$;
ALTER FUNCTION llenamos.repite_link(text,text,text,text,text) OWNER TO llenamos_platform_writer;
REVOKE ALL ON FUNCTION llenamos.repite_link(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.repite_link(text,text,text,text,text) TO llenamos_app;

-- El aviso de cambio de comercio refresca en vivo la pantalla de Repite del restaurante (sin datos personales).
CREATE POLICY platform_writer_event ON llenamos.events FOR INSERT TO llenamos_platform_writer WITH CHECK(llenamos.is_platform() AND topic='fidelizacion.repite');
GRANT INSERT ON llenamos.events TO llenamos_platform_writer;
GRANT USAGE ON SEQUENCE llenamos.events_id_seq TO llenamos_platform_writer;
