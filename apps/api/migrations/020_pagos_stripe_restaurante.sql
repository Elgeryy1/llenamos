-- Cobros con la Stripe del propio restaurante (W3): sesión de Checkout de la señal, cobro móvil de caja y recibo digital.
-- La clave la guarda cada restaurante en su bóveda cifrada (`integration_secrets`); aquí solo se añade el acceso
-- estrecho para que una operación pública abra la credencial del restaurante que ya resolvió, y las tablas del cobro móvil.

-- Credencial sellada del restaurante del ámbito público en curso. Solo devuelve algo si la API ya fijó
-- `app.public_restaurant` a ese restaurante tras resolver el enlace; nunca la de otro negocio ni sin ámbito.
CREATE FUNCTION llenamos.payments_stripe_ciphertext(p_rid text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT ciphertext FROM llenamos.integration_secrets
  WHERE restaurant_id=p_rid AND p_rid=nullif(current_setting('app.public_restaurant',true),'')
$$;
ALTER FUNCTION llenamos.payments_stripe_ciphertext(text) OWNER TO llenamos_worker_fn;
REVOKE ALL ON FUNCTION llenamos.payments_stripe_ciphertext(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.payments_stripe_ciphertext(text) TO llenamos_app;

-- Cabecera pública de la cuenta (nombre, local y color de marca) sin abrir lectura de restaurantes.
CREATE FUNCTION llenamos.payments_public_header(p_rid text,p_lid text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
  SELECT jsonb_build_object('restaurantName',r.name,'locationName',l.name,'brandColor',r.brand_color,'slug',r.slug)
  FROM llenamos.restaurants r JOIN llenamos.locations l ON l.restaurant_id=r.id AND l.id=p_lid
  WHERE r.id=p_rid AND p_rid=nullif(current_setting('app.public_restaurant',true),'')
$$;
ALTER FUNCTION llenamos.payments_public_header(text,text) OWNER TO llenamos_migrator;
REVOKE ALL ON FUNCTION llenamos.payments_public_header(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.payments_public_header(text,text) TO llenamos_app;

CREATE TABLE llenamos.pos_mobile_checkouts (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  bill_id varchar(128) NOT NULL, part_id varchar(128) NOT NULL, revision integer NOT NULL CHECK(revision>0),
  amount_cents integer NOT NULL CHECK(amount_cents>0), tip_cents integer NOT NULL DEFAULT 0 CHECK(tip_cents>=0),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','expired','failed','reconciliation_required')),
  token_hash char(64) NOT NULL, expires_at timestamptz NOT NULL, cash_session_id varchar(128) NOT NULL,
  -- Solicitud del QR de mesa (huella de credencial y requestId): repetirla rota el secreto del mismo cobro en vez de abrir otro.
  link_request char(64),
  -- Intento de pago: se fija una vez y no cambia (misma clave de idempotencia ante Stripe).
  start_request varchar(128), start_fingerprint char(64), started_at timestamptz,
  recipient jsonb, email varchar(254), accept_digital_receipt boolean NOT NULL DEFAULT false, consent_at timestamptz,
  language text NOT NULL DEFAULT 'es', livemode boolean, stripe_account varchar(100), stripe_name varchar(200), stripe_origin varchar(300),
  stripe_session_id varchar(200), stripe_url text, stripe_expires_at timestamptz,
  payment_id varchar(128), paid_at timestamptz,
  invoice_id varchar(128), invoice_state text NOT NULL DEFAULT 'none' CHECK(invoice_state IN ('none','pending','not_configured','done')),
  receipt_id varchar(128), receipt_path text, delivery text NOT NULL DEFAULT 'none',
  needs_reconciliation boolean NOT NULL DEFAULT false, last_error varchar(300),
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
-- Una parte solo admite un intento de pago vivo: sustituye a `paymentReservations`.
CREATE UNIQUE INDEX pos_mobile_part_inflight ON llenamos.pos_mobile_checkouts(restaurant_id,location_id,part_id) WHERE status='pending' AND start_request IS NOT NULL;
-- Una sesión de Stripe pertenece a un único cobro móvil del restaurante.
CREATE UNIQUE INDEX pos_mobile_session_once ON llenamos.pos_mobile_checkouts(restaurant_id,stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE UNIQUE INDEX pos_mobile_link_request ON llenamos.pos_mobile_checkouts(restaurant_id,location_id,link_request) WHERE link_request IS NOT NULL;
CREATE INDEX pos_mobile_reconcile ON llenamos.pos_mobile_checkouts(restaurant_id,updated_at) WHERE needs_reconciliation;
CREATE INDEX pos_mobile_bill ON llenamos.pos_mobile_checkouts(restaurant_id,location_id,bill_id);

CREATE TABLE llenamos.pos_mobile_incidents (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  checkout_id varchar(128) NOT NULL, external_id varchar(200) NOT NULL, code varchar(60) NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')), summary varchar(300) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE INDEX pos_mobile_incidents_open ON llenamos.pos_mobile_incidents(restaurant_id,location_id,created_at DESC) WHERE status='open';

CREATE TABLE llenamos.pos_digital_receipts (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  invoice_id varchar(128) NOT NULL, token_hash char(64) NOT NULL, expires_at timestamptz NOT NULL,
  email varchar(254), consent_at timestamptz, accepted_digital boolean NOT NULL DEFAULT false,
  delivery text NOT NULL DEFAULT 'none' CHECK(delivery IN ('none','queued','captured','sent','not_configured','failed')),
  message_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE INDEX pos_receipts_invoice ON llenamos.pos_digital_receipts(restaurant_id,location_id,invoice_id);
CREATE INDEX pos_receipts_queued ON llenamos.pos_digital_receipts(restaurant_id,created_at) WHERE delivery='queued';

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pos_mobile_checkouts','pos_mobile_incidents','pos_digital_receipts'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator',t);
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_access ON llenamos.%I USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id))',t);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON llenamos.pos_mobile_checkouts,llenamos.pos_mobile_incidents,llenamos.pos_digital_receipts TO llenamos_app;

-- Ámbito público (enlace privado con credencial): el pagador lee y avanza su propio cobro (y el QR de mesa lo crea tras
-- comprobar el enlace de la mesa); el recibo solo se lee.
-- Las credenciales de enlace se comprueban en la API. Las tablas de dinero (cuentas, partes, caja, facturas) solo
-- se leen, nunca se escriben desde el ámbito público.
CREATE POLICY public_view ON llenamos.pos_mobile_checkouts FOR SELECT TO llenamos_app USING(llenamos.public_scope(restaurant_id));
CREATE POLICY public_insert ON llenamos.pos_mobile_checkouts FOR INSERT TO llenamos_app WITH CHECK(llenamos.public_scope(restaurant_id));
CREATE POLICY public_update ON llenamos.pos_mobile_checkouts FOR UPDATE TO llenamos_app USING(llenamos.public_scope(restaurant_id)) WITH CHECK(llenamos.public_scope(restaurant_id));
CREATE POLICY public_view ON llenamos.pos_digital_receipts FOR SELECT TO llenamos_app USING(llenamos.public_scope(restaurant_id));
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pos_bills','pos_bill_parts','pos_settings','pos_cash_sessions','pos_invoices','pos_fiscal_records'] LOOP
    EXECUTE format('CREATE POLICY public_view ON llenamos.%I FOR SELECT TO llenamos_app USING(llenamos.public_scope(restaurant_id))',t);
  END LOOP;
END $$;
