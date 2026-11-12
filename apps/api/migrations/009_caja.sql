-- Caja, fiscal, cobros e impresión (V5). Cada fila lleva restaurante y local; RLS FORCE por restaurante.
-- Las filas de dominio guardan el documento validado por @llenamos/core en `data`; las columnas
-- promocionadas sirven para índices, unicidad y consultas acotadas.
CREATE TABLE llenamos.pos_settings (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL,
  settings jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,location_id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE TABLE llenamos.pos_cash_sessions (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  register_id varchar(128) NOT NULL, status text NOT NULL CHECK(status IN ('open','closed')),
  opened_at timestamptz NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
-- Sustituye a registerLocks: una sola apertura viva por terminal, garantizada por el índice.
CREATE UNIQUE INDEX pos_cash_one_open ON llenamos.pos_cash_sessions(restaurant_id,location_id,register_id) WHERE status='open';
CREATE INDEX pos_cash_recent ON llenamos.pos_cash_sessions(restaurant_id,location_id,opened_at DESC);
CREATE TABLE llenamos.pos_cash_movements (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  cash_session_id varchar(128) NOT NULL, distribution_id varchar(128), data jsonb NOT NULL,
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id,cash_session_id) REFERENCES llenamos.pos_cash_sessions(restaurant_id,location_id,id)
);
CREATE INDEX pos_movements_session ON llenamos.pos_cash_movements(restaurant_id,location_id,cash_session_id);
-- Un reparto de propinas se paga una sola vez.
CREATE UNIQUE INDEX pos_movements_one_payout ON llenamos.pos_cash_movements(restaurant_id,location_id,distribution_id) WHERE distribution_id IS NOT NULL;
CREATE TABLE llenamos.pos_bills (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  target_kind text NOT NULL CHECK(target_kind IN ('session','takeaway')), target_id varchar(128) NOT NULL,
  status text NOT NULL CHECK(status IN ('open','locked','settled','cancelled')),
  revision integer NOT NULL CHECK(revision>0), opened_at timestamptz NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(restaurant_id,location_id,id),
  UNIQUE(restaurant_id,location_id,target_kind,target_id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE INDEX pos_bills_active ON llenamos.pos_bills(restaurant_id,location_id,status,opened_at DESC);
CREATE TABLE llenamos.pos_bill_parts (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  bill_id varchar(128) NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id,bill_id) REFERENCES llenamos.pos_bills(restaurant_id,location_id,id)
);
CREATE INDEX pos_parts_bill ON llenamos.pos_bill_parts(restaurant_id,location_id,bill_id);
CREATE TABLE llenamos.pos_payments (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  bill_id varchar(128) NOT NULL, part_id varchar(128) NOT NULL, cash_session_id varchar(128) NOT NULL,
  original_payment_id varchar(128), kind text NOT NULL CHECK(kind IN ('charge','refund')),
  status text NOT NULL CHECK(status IN ('pending','succeeded','failed','cancelled')),
  method text NOT NULL CHECK(method IN ('cash','card','stripe','deposit')), external_id varchar(200), at timestamptz NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id,bill_id) REFERENCES llenamos.pos_bills(restaurant_id,location_id,id)
);
CREATE INDEX pos_payments_bill ON llenamos.pos_payments(restaurant_id,location_id,bill_id);
CREATE INDEX pos_payments_session ON llenamos.pos_payments(restaurant_id,location_id,cash_session_id);
CREATE INDEX pos_payments_original ON llenamos.pos_payments(restaurant_id,location_id,original_payment_id) WHERE original_payment_id IS NOT NULL;
CREATE INDEX pos_payments_recent ON llenamos.pos_payments(restaurant_id,location_id,at DESC);
-- Un pago externo (datáfono o proveedor) no se registra dos veces como cobro.
CREATE UNIQUE INDEX pos_payments_external_once ON llenamos.pos_payments(restaurant_id,method,external_id) WHERE kind='charge' AND status='succeeded' AND external_id IS NOT NULL;
CREATE TABLE llenamos.pos_tip_distributions (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  cash_session_id varchar(128) NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(restaurant_id,location_id,id), UNIQUE(restaurant_id,location_id,cash_session_id),
  FOREIGN KEY(restaurant_id,location_id,cash_session_id) REFERENCES llenamos.pos_cash_sessions(restaurant_id,location_id,id)
);
-- Una devolución de consumo exige coordinar su rectificativa: queda como revisión pendiente.
CREATE TABLE llenamos.pos_refund_reviews (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  payment_id varchar(128) NOT NULL, bill_id varchar(128) NOT NULL, part_id varchar(128) NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents>0), reason varchar(200) NOT NULL,
  status text NOT NULL DEFAULT 'requires_fiscal_correction' CHECK(status IN ('requires_fiscal_correction','corrected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id,bill_id) REFERENCES llenamos.pos_bills(restaurant_id,location_id,id)
);
CREATE INDEX pos_refund_reviews_pending ON llenamos.pos_refund_reviews(restaurant_id,location_id,created_at DESC) WHERE status='requires_fiscal_correction';
-- Fiscal. La cadena es por NIF e instalación y su id es único en toda la base: impide duplicar
-- una instalación entre restaurantes (la unicidad se aplica aunque RLS oculte la otra fila).
CREATE TABLE llenamos.pos_fiscal_chains (
  id char(64) PRIMARY KEY, restaurant_id varchar(128) NOT NULL REFERENCES llenamos.restaurants(id),
  identity_hash char(64) NOT NULL, data jsonb NOT NULL
);
CREATE TABLE llenamos.pos_invoice_series (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE TABLE llenamos.pos_invoices (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  bill_id varchar(128) NOT NULL, part_id varchar(128) NOT NULL, series_id varchar(128) NOT NULL,
  sequence integer NOT NULL CHECK(sequence>0), issuer_nif varchar(9) NOT NULL, number varchar(60) NOT NULL,
  record_id varchar(128) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), data jsonb NOT NULL,
  PRIMARY KEY(restaurant_id,location_id,id),
  UNIQUE(restaurant_id,location_id,series_id,sequence), UNIQUE(restaurant_id,issuer_nif,number),
  FOREIGN KEY(restaurant_id,location_id,bill_id) REFERENCES llenamos.pos_bills(restaurant_id,location_id,id)
);
CREATE INDEX pos_invoices_recent ON llenamos.pos_invoices(restaurant_id,location_id,created_at DESC);
-- Una parte lleva como mucho una factura original (las rectificativas no apuntan a una parte).
CREATE UNIQUE INDEX pos_invoices_part_once ON llenamos.pos_invoices(restaurant_id,location_id,part_id) WHERE data->>'type' IN ('F1','F2');
CREATE TABLE llenamos.pos_fiscal_records (
  restaurant_id varchar(128) NOT NULL, id varchar(128) NOT NULL, location_id varchar(128) NOT NULL,
  chain_id char(64) NOT NULL REFERENCES llenamos.pos_fiscal_chains(id), chain_sequence integer NOT NULL CHECK(chain_sequence>0),
  invoice_id varchar(128) NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(restaurant_id,id), UNIQUE(chain_id,chain_sequence)
);
CREATE TABLE llenamos.pos_fiscal_outbox (
  restaurant_id varchar(128) NOT NULL, record_id varchar(128) NOT NULL, chain_id char(64) NOT NULL,
  location_id varchar(128) NOT NULL, invoice_id varchar(128) NOT NULL,
  status text NOT NULL, attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL,
  lease_until timestamptz, lease_owner text, PRIMARY KEY(restaurant_id,record_id)
);
CREATE INDEX pos_fiscal_outbox_due ON llenamos.pos_fiscal_outbox(restaurant_id,chain_id,next_attempt_at) WHERE status NOT IN ('accepted','accepted_with_errors','not_configured');
CREATE TABLE llenamos.pos_invoice_events (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  invoice_id varchar(128) NOT NULL, kind text NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(restaurant_id,location_id,id)
);
CREATE INDEX pos_invoice_events_invoice ON llenamos.pos_invoice_events(restaurant_id,location_id,invoice_id);
-- Impresión.
CREATE TABLE llenamos.pos_printers (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  active boolean NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE TABLE llenamos.pos_print_bridges (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id varchar(128) NOT NULL,
  token_hash char(64) NOT NULL, revoked boolean NOT NULL DEFAULT false, rotated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  PRIMARY KEY(restaurant_id,location_id,id),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);
CREATE TABLE llenamos.pos_print_jobs (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id char(64) NOT NULL,
  printer_id varchar(128) NOT NULL, bridge_id varchar(128) NOT NULL, kind text NOT NULL, source_id varchar(128) NOT NULL,
  copy integer NOT NULL, status text NOT NULL CHECK(status IN ('queued','leased','printed','failed','uncertain','cancelled')), lease_until timestamptz, lease_owner varchar(128), lease_token_hash char(64),
  attempts integer NOT NULL DEFAULT 0, last_error varchar(300), payload_hash char(64) NOT NULL, payload_base64 text NOT NULL,
  document jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,location_id,id)
);
CREATE INDEX pos_print_jobs_bridge ON llenamos.pos_print_jobs(restaurant_id,location_id,bridge_id,status,created_at);
CREATE INDEX pos_print_jobs_source ON llenamos.pos_print_jobs(restaurant_id,location_id,printer_id,source_id,kind);
CREATE TABLE llenamos.pos_print_requests (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id char(64) NOT NULL,
  kind text NOT NULL, source_id varchar(128) NOT NULL, printer_id varchar(128), copy integer NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','processed','not_configured','failed')),
  requested_by text, requested_at timestamptz NOT NULL, data jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(restaurant_id,location_id,id)
);
CREATE INDEX pos_print_requests_pending ON llenamos.pos_print_requests(restaurant_id,location_id,status) WHERE status IN ('queued','not_configured');
CREATE TABLE llenamos.pos_print_statuses (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id char(64) NOT NULL,
  printer_id varchar(128) NOT NULL, source_id varchar(128) NOT NULL, kind text NOT NULL, status text NOT NULL,
  attempts integer NOT NULL, last_error varchar(300), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(restaurant_id,location_id,id)
);
CREATE INDEX pos_print_statuses_recent ON llenamos.pos_print_statuses(restaurant_id,location_id,updated_at DESC);
CREATE INDEX pos_print_statuses_source ON llenamos.pos_print_statuses(restaurant_id,location_id,source_id);
CREATE TABLE llenamos.pos_print_copies (
  restaurant_id varchar(128) NOT NULL, location_id varchar(128) NOT NULL, id char(64) NOT NULL, value integer NOT NULL,
  PRIMARY KEY(restaurant_id,location_id,id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pos_settings','pos_cash_sessions','pos_cash_movements','pos_bills','pos_bill_parts','pos_payments','pos_tip_distributions',
    'pos_fiscal_chains','pos_invoice_series','pos_invoices','pos_fiscal_records','pos_fiscal_outbox','pos_invoice_events','pos_printers','pos_print_bridges',
    'pos_print_jobs','pos_print_requests','pos_print_statuses','pos_print_copies','pos_refund_reviews'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator',t);
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_access ON llenamos.%I USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id))',t);
    EXECUTE format('REVOKE ALL ON llenamos.%I FROM PUBLIC',t);
  END LOOP;
  -- Solo los procedimientos del puente ven sus tablas sin identidad de usuario.
  FOREACH t IN ARRAY ARRAY['pos_print_bridges','pos_print_jobs','pos_printers','pos_print_statuses'] LOOP
    EXECUTE format('CREATE POLICY bridge_custody ON llenamos.%I TO llenamos_migrator USING(true) WITH CHECK(true)',t);
  END LOOP;
END $$;
CREATE POLICY bridge_restaurant_custody ON llenamos.restaurants FOR SELECT TO llenamos_migrator USING(true);
-- Mínimo privilegio: el rol de ejecución no borra nada salvo lo que el dominio ya modela como
-- estado. Las facturas, registros fiscales y pagos no se actualizan ni se borran.
GRANT SELECT,INSERT,UPDATE ON llenamos.pos_settings,llenamos.pos_cash_sessions,llenamos.pos_bills,llenamos.pos_fiscal_chains,
  llenamos.pos_invoice_series,llenamos.pos_fiscal_outbox,llenamos.pos_printers,llenamos.pos_print_bridges,llenamos.pos_print_requests,
  llenamos.pos_print_statuses,llenamos.pos_print_copies,llenamos.pos_print_jobs TO llenamos_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON llenamos.pos_bill_parts TO llenamos_app;
GRANT SELECT,INSERT ON llenamos.pos_payments TO llenamos_app;
GRANT SELECT,INSERT,UPDATE ON llenamos.pos_refund_reviews TO llenamos_app;
GRANT SELECT,INSERT ON llenamos.pos_cash_movements,llenamos.pos_tip_distributions,llenamos.pos_invoices,llenamos.pos_fiscal_records,llenamos.pos_invoice_events TO llenamos_app;

-- Personal activo de un local: la lectura de otros miembros no la permite RLS, así que se hace con un
-- procedimiento estrecho que solo responde a quien ya accede al restaurante.
CREATE FUNCTION llenamos.pos_active_members(rid text,lid text,uids text[]) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos,pg_temp AS $$
  SELECT m.uid FROM llenamos.memberships m WHERE llenamos.can_access_restaurant(rid) AND m.restaurant_id=rid AND m.uid=ANY(uids) AND m.active
    AND (cardinality(m.location_ids)=0 OR lid=ANY(m.location_ids))
$$;
REVOKE ALL ON FUNCTION llenamos.pos_active_members(text,text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.pos_active_members(text,text,text[]) TO llenamos_app;

-- Puente de impresión: se identifica con su credencial, no con un usuario. Solo dos procedimientos.
CREATE FUNCTION llenamos.pos_bridge_scope(rid text,lid text,bridge text,token_hash text) RETURNS TABLE(plan text,module_overrides jsonb,active_modules text[],entitlement_version integer,access_valid_until timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,llenamos,pg_temp AS $$
  SELECT r.plan,r.module_overrides,r.active_modules,r.entitlement_version,r.access_valid_until FROM llenamos.restaurants r
  JOIN llenamos.pos_print_bridges b ON b.restaurant_id=r.id AND b.location_id=lid AND b.id=bridge
  WHERE r.id=rid AND NOT b.revoked AND b.token_hash=pos_bridge_scope.token_hash
    AND (r.entitlement_version IS NULL OR r.access_valid_until>now())
$$;
CREATE FUNCTION llenamos.pos_bridge_claim(rid text,lid text,bridge text,token_hash text,max_jobs integer,lease_hashes text[],lease_seconds integer)
RETURNS TABLE(idx integer,id text,printer_id text,payload_hash text,payload_base64 text,lease_until timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos,pg_temp AS $$
DECLARE job record; n integer:=0; until timestamptz:=now()+make_interval(secs=>lease_seconds);
BEGIN
  IF NOT EXISTS(SELECT FROM llenamos.pos_print_bridges b WHERE b.restaurant_id=rid AND b.location_id=lid AND b.id=bridge AND NOT b.revoked AND b.token_hash=pos_bridge_claim.token_hash) THEN
    RAISE EXCEPTION 'bridge_denied' USING ERRCODE='42501';
  END IF;
  max_jobs:=least(max_jobs,coalesce(cardinality(lease_hashes),0));
  -- Un lease caducado nunca se reintenta solo: puede haber salido ya papel.
  UPDATE llenamos.pos_print_jobs j SET status='uncertain',updated_at=now(),
    last_error='El lease caducó sin confirmación. Revisa el papel antes de pedir una copia.'
    WHERE j.restaurant_id=rid AND j.location_id=lid AND j.bridge_id=bridge AND j.status='leased' AND j.lease_until<=now();
  UPDATE llenamos.pos_print_statuses s SET status='uncertain',last_error=j.last_error,updated_at=now()
    FROM llenamos.pos_print_jobs j WHERE j.restaurant_id=rid AND j.location_id=lid AND j.bridge_id=bridge AND j.status='uncertain'
    AND s.restaurant_id=j.restaurant_id AND s.location_id=j.location_id AND s.id=j.id AND s.status='leased';
  FOR job IN SELECT j.* FROM llenamos.pos_print_jobs j
    JOIN llenamos.pos_printers p ON p.restaurant_id=j.restaurant_id AND p.location_id=j.location_id AND p.id=j.printer_id AND p.active
      AND p.data->>'bridgeId'=bridge
    WHERE j.restaurant_id=rid AND j.location_id=lid AND j.bridge_id=bridge AND j.status='queued'
    ORDER BY j.created_at,j.id LIMIT max_jobs FOR UPDATE OF j SKIP LOCKED LOOP
    n:=n+1;
    UPDATE llenamos.pos_print_jobs j SET status='leased',lease_until=until,lease_owner=bridge,lease_token_hash=lease_hashes[n],attempts=j.attempts+1,updated_at=now()
      WHERE j.restaurant_id=job.restaurant_id AND j.location_id=job.location_id AND j.id=job.id;
    UPDATE llenamos.pos_print_statuses s SET status='leased',attempts=job.attempts+1,updated_at=now()
      WHERE s.restaurant_id=job.restaurant_id AND s.location_id=job.location_id AND s.id=job.id;
    idx:=n;id:=job.id;printer_id:=job.printer_id;payload_hash:=job.payload_hash;payload_base64:=job.payload_base64;lease_until:=until;
    RETURN NEXT;
  END LOOP;
  UPDATE llenamos.pos_print_bridges b SET last_seen_at=now() WHERE b.restaurant_id=rid AND b.location_id=lid AND b.id=bridge;
END $$;
CREATE FUNCTION llenamos.pos_bridge_confirm(rid text,lid text,bridge text,token_hash text,job_id text,lease_hash text,new_status text,error_text text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos,pg_temp AS $$
DECLARE job llenamos.pos_print_jobs; final text;
BEGIN
  IF NOT EXISTS(SELECT FROM llenamos.pos_print_bridges b WHERE b.restaurant_id=rid AND b.location_id=lid AND b.id=bridge AND NOT b.revoked AND b.token_hash=pos_bridge_confirm.token_hash) THEN
    RAISE EXCEPTION 'bridge_denied' USING ERRCODE='42501';
  END IF;
  IF new_status NOT IN ('printed','failed','uncertain') THEN RAISE EXCEPTION 'status_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO job FROM llenamos.pos_print_jobs j WHERE j.restaurant_id=rid AND j.location_id=lid AND j.id=job_id FOR UPDATE;
  IF NOT FOUND OR job.lease_owner IS DISTINCT FROM bridge OR job.lease_token_hash IS DISTINCT FROM lease_hash THEN
    RAISE EXCEPTION 'bridge_denied' USING ERRCODE='42501';
  END IF;
  IF job.status IN ('printed','failed','uncertain') THEN RETURN job.status; END IF;
  IF job.status<>'leased' THEN RAISE EXCEPTION 'lease_inactive' USING ERRCODE='P0001'; END IF;
  final:=CASE WHEN job.lease_until<=now() THEN 'uncertain' ELSE new_status END;
  UPDATE llenamos.pos_print_jobs j SET status=final,updated_at=now(),
    last_error=CASE WHEN final='uncertain' AND new_status<>'uncertain' THEN 'No se puede asegurar el resultado. Revisa el papel antes de solicitar copia.' ELSE error_text END
    WHERE j.restaurant_id=rid AND j.location_id=lid AND j.id=job_id;
  UPDATE llenamos.pos_print_statuses s SET status=final,updated_at=now(),
    last_error=(SELECT j.last_error FROM llenamos.pos_print_jobs j WHERE j.restaurant_id=rid AND j.location_id=lid AND j.id=job_id)
    WHERE s.restaurant_id=rid AND s.location_id=lid AND s.id=job_id;
  RETURN final;
END $$;
REVOKE ALL ON FUNCTION llenamos.pos_bridge_scope(text,text,text,text),llenamos.pos_bridge_claim(text,text,text,text,integer,text[],integer),
  llenamos.pos_bridge_confirm(text,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.pos_bridge_scope(text,text,text,text),llenamos.pos_bridge_claim(text,text,text,text,integer,text[],integer),
  llenamos.pos_bridge_confirm(text,text,text,text,text,text,text,text) TO llenamos_app;

-- Las funciones SECURITY DEFINER las ejecuta llenamos_migrator (sin BYPASSRLS): sus políticas de custodia
-- delimitan lo que ven. Si las poseyera el rol que migra (superusuario) se saltarían RLS.
ALTER FUNCTION llenamos.pos_active_members(text,text,text[]) OWNER TO llenamos_migrator;
ALTER FUNCTION llenamos.pos_bridge_scope(text,text,text,text) OWNER TO llenamos_migrator;
ALTER FUNCTION llenamos.pos_bridge_claim(text,text,text,text,integer,text[],integer) OWNER TO llenamos_migrator;
ALTER FUNCTION llenamos.pos_bridge_confirm(text,text,text,text,text,text,text,text) OWNER TO llenamos_migrator;
GRANT EXECUTE ON FUNCTION llenamos.can_access_restaurant(text) TO llenamos_migrator;
