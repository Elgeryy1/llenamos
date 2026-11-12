-- Personal, inventario, costes y compras (V6). Cada documento conserva el contrato de
-- `@llenamos/core` en `doc` (instantes en ms UTC); las columnas generadas solo sirven para filtrar con
-- índice. Todas las tablas llevan restaurante y local, RLS FORCE `tenant_access`, dueño
-- `llenamos_migrator` y solo los GRANT mínimos para `llenamos_app`.

DO $$
DECLARE spec record; t text;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('staff_time_entries', ', uid text GENERATED ALWAYS AS (doc->>''uid'') STORED, entry_date text GENERATED ALWAYS AS (doc->>''date'') STORED, start_at bigint GENERATED ALWAYS AS ((doc->>''startAt'')::bigint) STORED, status text GENERATED ALWAYS AS (doc->>''status'') STORED'),
    ('staff_time_entry_events', ', entry_id text GENERATED ALWAYS AS (doc->>''entryId'') STORED'),
    ('staff_pins', ''),
    ('staff_shifts', ', uid text GENERATED ALWAYS AS (doc->>''uid'') STORED, start_at bigint GENERATED ALWAYS AS ((doc->>''startAt'')::bigint) STORED, week_start text GENERATED ALWAYS AS (doc->>''weekStart'') STORED, status text GENERATED ALWAYS AS (doc->>''status'') STORED'),
    ('inv_ingredients', ', active boolean GENERATED ALWAYS AS ((doc->>''active'')::boolean) STORED'),
    ('inv_ingredient_costs', ''),
    ('inv_stock_movements', ', ingredient_id text GENERATED ALWAYS AS (doc->>''ingredientId'') STORED, at bigint GENERATED ALWAYS AS ((doc->>''at'')::bigint) STORED, line_id text GENERATED ALWAYS AS (doc->>''lineId'') STORED'),
    ('inv_stock_alerts', ', status text GENERATED ALWAYS AS (doc->>''status'') STORED'),
    ('inv_recipes', ', item_id text GENERATED ALWAYS AS (doc->>''itemId'') STORED, variant_key text GENERATED ALWAYS AS (coalesce(doc->>''variantId'','''')) STORED, active boolean GENERATED ALWAYS AS ((doc->>''active'')::boolean) STORED'),
    ('inv_recipe_versions', ', recipe_id text GENERATED ALWAYS AS (doc->>''recipeId'') STORED, version integer GENERATED ALWAYS AS ((doc->>''version'')::integer) STORED'),
    ('inv_counts', ', status text GENERATED ALWAYS AS (doc->>''status'') STORED, started_at bigint GENERATED ALWAYS AS ((doc->>''startedAt'')::bigint) STORED'),
    ('inv_suppliers', ''),
    ('inv_supplier_items', ', supplier_id text GENERATED ALWAYS AS (doc->>''supplierId'') STORED, ingredient_id text GENERATED ALWAYS AS (doc->>''ingredientId'') STORED, preferred boolean GENERATED ALWAYS AS ((doc->>''preferred'')::boolean) STORED'),
    ('inv_purchase_orders', ', supplier_id text GENERATED ALWAYS AS (doc->>''supplierId'') STORED, status text GENERATED ALWAYS AS (doc->>''status'') STORED, reference text GENERATED ALWAYS AS (doc->>''reference'') STORED'),
    ('inv_goods_receipts', ', supplier_id text GENERATED ALWAYS AS (doc->>''supplierId'') STORED, purchase_order_id text GENERATED ALWAYS AS (doc->>''purchaseOrderId'') STORED, received_at bigint GENERATED ALWAYS AS ((doc->>''receivedAt'')::bigint) STORED'),
    ('inv_line_costs', ', at bigint GENERATED ALWAYS AS ((doc->>''at'')::bigint) STORED, state text GENERATED ALWAYS AS (doc->>''state'') STORED')
  ) AS s(name, extra) LOOP
    EXECUTE format($f$CREATE TABLE llenamos.%I (
      restaurant_id varchar(128) NOT NULL,
      location_id varchar(128) NOT NULL,
      id varchar(128) NOT NULL,
      doc jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
      %s,
      PRIMARY KEY(restaurant_id,location_id,id),
      FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
    )$f$, spec.name, spec.extra);
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY', spec.name);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY', spec.name);
    EXECUTE format('CREATE POLICY tenant_access ON llenamos.%I USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id))', spec.name);
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator', spec.name);
  END LOOP;
  -- Libros inmutables: sin UPDATE ni DELETE aunque se rompa la aplicación.
  FOREACH t IN ARRAY ARRAY['staff_time_entry_events','inv_stock_movements','inv_recipe_versions','inv_goods_receipts'] LOOP
    EXECUTE format('GRANT SELECT,INSERT ON llenamos.%I TO llenamos_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['staff_time_entries','inv_ingredients','inv_ingredient_costs','inv_stock_alerts','inv_recipes','inv_counts','inv_suppliers','inv_supplier_items','inv_purchase_orders','inv_line_costs'] LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON llenamos.%I TO llenamos_app', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['staff_pins','staff_shifts'] LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON llenamos.%I TO llenamos_app', t);
  END LOOP;
END $$;

-- Ajustes por local: `staff` e `inventory`.
CREATE TABLE llenamos.fase4_settings (
  restaurant_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  kind text NOT NULL CHECK(kind IN ('staff','inventory')),
  doc jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY(restaurant_id,location_id,kind),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);

-- Fichaje abierto por persona en todo el restaurante: la PK impide dos fichajes abiertos a la vez.
CREATE TABLE llenamos.staff_clock_locks (
  restaurant_id varchar(128) NOT NULL,
  uid text NOT NULL,
  location_id varchar(128) NOT NULL,
  entry_id varchar(128) NOT NULL,
  PRIMARY KEY(restaurant_id,uid),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);

-- Actividad (auditoría) de personal e inventario.
CREATE TABLE llenamos.fase4_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id varchar(128) NOT NULL,
  location_id varchar(128) NOT NULL,
  action varchar(80) NOT NULL,
  summary varchar(300) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  actor_uid text,
  actor_name varchar(80),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(restaurant_id,location_id) REFERENCES llenamos.locations(restaurant_id,id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fase4_settings','staff_clock_locks','fase4_activity'] LOOP
    EXECUTE format('ALTER TABLE llenamos.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE llenamos.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_access ON llenamos.%I USING(llenamos.can_access_restaurant(restaurant_id)) WITH CHECK(llenamos.can_access_restaurant(restaurant_id))', t);
    EXECUTE format('ALTER TABLE llenamos.%I OWNER TO llenamos_migrator', t);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON llenamos.fase4_settings TO llenamos_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON llenamos.staff_clock_locks TO llenamos_app;
GRANT SELECT,INSERT ON llenamos.fase4_activity TO llenamos_app;

-- Lecturas acotadas por persona, fecha, estado o ingrediente.
CREATE INDEX staff_entries_person ON llenamos.staff_time_entries(restaurant_id,location_id,uid,start_at);
CREATE INDEX staff_entries_date ON llenamos.staff_time_entries(restaurant_id,location_id,entry_date,start_at);
CREATE INDEX staff_entries_start ON llenamos.staff_time_entries(restaurant_id,location_id,start_at);
CREATE INDEX staff_entries_open ON llenamos.staff_time_entries(restaurant_id,location_id) WHERE status='open';
CREATE INDEX staff_entry_events_entry ON llenamos.staff_time_entry_events(restaurant_id,location_id,entry_id);
CREATE INDEX staff_shifts_week ON llenamos.staff_shifts(restaurant_id,location_id,week_start,start_at);
CREATE INDEX staff_shifts_person ON llenamos.staff_shifts(restaurant_id,location_id,uid,start_at);
CREATE INDEX staff_shifts_start ON llenamos.staff_shifts(restaurant_id,location_id,start_at);
CREATE INDEX inv_ingredients_active ON llenamos.inv_ingredients(restaurant_id,location_id) WHERE active;
CREATE INDEX inv_movements_ingredient ON llenamos.inv_stock_movements(restaurant_id,location_id,ingredient_id,at DESC);
CREATE INDEX inv_movements_at ON llenamos.inv_stock_movements(restaurant_id,location_id,at DESC);
CREATE INDEX inv_movements_line ON llenamos.inv_stock_movements(restaurant_id,location_id,line_id) WHERE line_id IS NOT NULL;
-- Una sola receta por plato y variante, también a nivel de base de datos.
CREATE UNIQUE INDEX inv_recipes_item_variant ON llenamos.inv_recipes(restaurant_id,location_id,item_id,variant_key);
CREATE UNIQUE INDEX inv_recipe_versions_unique ON llenamos.inv_recipe_versions(restaurant_id,location_id,recipe_id,version);
CREATE INDEX inv_counts_recent ON llenamos.inv_counts(restaurant_id,location_id,started_at DESC);
CREATE INDEX inv_items_supplier ON llenamos.inv_supplier_items(restaurant_id,location_id,supplier_id);
CREATE INDEX inv_items_ingredient ON llenamos.inv_supplier_items(restaurant_id,location_id,ingredient_id);
-- Un solo formato preferido por ingrediente.
CREATE UNIQUE INDEX inv_items_one_preferred ON llenamos.inv_supplier_items(restaurant_id,location_id,ingredient_id) WHERE preferred;
CREATE INDEX inv_orders_status ON llenamos.inv_purchase_orders(restaurant_id,location_id,status);
CREATE INDEX inv_orders_created ON llenamos.inv_purchase_orders(restaurant_id,location_id,created_at DESC);
-- Sustituye a `purchaseReferences`: referencia única por local.
CREATE UNIQUE INDEX inv_orders_reference ON llenamos.inv_purchase_orders(restaurant_id,location_id,reference);
CREATE INDEX inv_receipts_order ON llenamos.inv_goods_receipts(restaurant_id,location_id,purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX inv_receipts_recent ON llenamos.inv_goods_receipts(restaurant_id,location_id,received_at DESC);
CREATE INDEX inv_line_costs_at ON llenamos.inv_line_costs(restaurant_id,location_id,at);
CREATE INDEX fase4_activity_recent ON llenamos.fase4_activity(restaurant_id,location_id,id DESC);

-- RLS solo deja ver a cada persona su propia membresía: este procedimiento estrecho devuelve las
-- personas activas que trabajan en un local. Exige `can_access_restaurant` (miembro con suscripción vigente,
-- o el worker acotado a `app.restaurant_id`) y, si hay un actor, que este tenga acceso a ese local.
-- Devuelve solo lo imprescindible: uid, nombre y rol.
GRANT EXECUTE ON FUNCTION llenamos.can_access_restaurant(text) TO llenamos_migrator;
CREATE FUNCTION llenamos.fase4_local_members(rid text, lid text) RETURNS TABLE(uid text, display_name text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,llenamos,pg_temp AS $$
  SELECT m.uid, m.display_name::text, m.role FROM llenamos.memberships m
  WHERE (llenamos.can_access_restaurant(rid)
      -- El worker (V2) entra acotado a `app.restaurant_id`; dentro de SECURITY DEFINER `current_user` es el dueño, por eso se mira `session_user`.
      OR (NOT llenamos.is_platform() AND rid=nullif(current_setting('app.restaurant_id',true),'')
        AND coalesce(pg_has_role(session_user,to_regrole('llenamos_worker'),'member'),false)))
    AND (llenamos.actor_uid() IS NULL OR coalesce(pg_has_role(session_user,to_regrole('llenamos_worker'),'member'),false) OR EXISTS(SELECT FROM llenamos.memberships a WHERE a.restaurant_id=rid AND a.uid=llenamos.actor_uid() AND a.active
      AND (cardinality(a.location_ids)=0 OR lid=ANY(a.location_ids))))
    AND m.restaurant_id=rid AND m.active AND NOT m.invitation_pending
    AND (cardinality(m.location_ids)=0 OR lid=ANY(m.location_ids))
$$;
ALTER FUNCTION llenamos.fase4_local_members(text,text) OWNER TO llenamos_migrator;
REVOKE ALL ON FUNCTION llenamos.fase4_local_members(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.fase4_local_members(text,text) TO llenamos_app;

-- Reconciliación del consumo (inventario): líneas de pedido recientes de un local, por fecha de pedido y sin recorrer el histórico.
CREATE INDEX sala_lines_placed ON llenamos.sala_order_lines(restaurant_id,location_id,((doc->>'placedAt')::bigint));

-- Pedidos sin sesión (QR de mesa y recogida web): sala resuelve el local con `sala_public_scope` y, en la misma transacción,
-- el descuento de stock necesita tocar solo lo imprescindible de ese local. Políticas estrechas por orden, como las de 008.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['inv_ingredients','inv_ingredient_costs','inv_stock_alerts','inv_line_costs'] LOOP
    EXECUTE format('CREATE POLICY sala_public_select ON llenamos.%I FOR SELECT USING(restaurant_id=llenamos.sala_public_scope_id() AND location_id=llenamos.sala_public_location_id())', t);
    EXECUTE format('CREATE POLICY sala_public_insert ON llenamos.%I FOR INSERT WITH CHECK(restaurant_id=llenamos.sala_public_scope_id() AND location_id=llenamos.sala_public_location_id())', t);
    EXECUTE format('CREATE POLICY sala_public_update ON llenamos.%I FOR UPDATE USING(restaurant_id=llenamos.sala_public_scope_id() AND location_id=llenamos.sala_public_location_id()) WITH CHECK(restaurant_id=llenamos.sala_public_scope_id() AND location_id=llenamos.sala_public_location_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['inv_stock_movements','inv_recipes','fase4_settings'] LOOP
    EXECUTE format('CREATE POLICY sala_public_select ON llenamos.%I FOR SELECT USING(restaurant_id=llenamos.sala_public_scope_id() AND location_id=llenamos.sala_public_location_id())', t);
  END LOOP;
  CREATE POLICY sala_public_insert ON llenamos.inv_stock_movements FOR INSERT WITH CHECK(restaurant_id=llenamos.sala_public_scope_id() AND location_id=llenamos.sala_public_location_id());
  CREATE POLICY sala_public_insert ON llenamos.fase4_activity FOR INSERT WITH CHECK(restaurant_id=llenamos.sala_public_scope_id() AND location_id=llenamos.sala_public_location_id());
END $$;
CREATE POLICY sala_public_insert ON llenamos.jobs FOR INSERT WITH CHECK(restaurant_id=llenamos.sala_public_scope_id() AND kind='inventario.reconciliar');
CREATE POLICY sala_public_select ON llenamos.jobs FOR SELECT USING(restaurant_id=llenamos.sala_public_scope_id() AND kind='inventario.reconciliar');
