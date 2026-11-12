-- Ajustes generales del restaurante (nombre, color e idioma) por un procedimiento estrecho:
-- el rol HTTP sigue sin poder escribir `restaurants`; solo owner y manager activos, y solo si
-- el restaurante del contexto es el que se modifica.
GRANT SELECT ON llenamos.restaurants,llenamos.memberships TO llenamos_migrator;
GRANT EXECUTE ON FUNCTION llenamos.can_access_restaurant(text) TO llenamos_migrator;
ALTER TABLE llenamos.restaurants ADD COLUMN updated_by text, ADD COLUMN updated_at timestamptz;
GRANT UPDATE(name,brand_color,locale,updated_by,updated_at) ON llenamos.restaurants TO llenamos_migrator;
CREATE POLICY settings_update ON llenamos.restaurants FOR UPDATE TO llenamos_migrator
  USING(llenamos.can_access_restaurant(id)) WITH CHECK(llenamos.can_access_restaurant(id));
CREATE FUNCTION llenamos.restaurant_settings_save(rid text,new_name text,new_color text,new_locale text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,llenamos AS $$
DECLARE actor_role text; clean_name text:=btrim(new_name);
BEGIN
  IF llenamos.is_platform() OR NOT llenamos.can_access_restaurant(rid) THEN RAISE EXCEPTION 'settings_denied' USING ERRCODE='42501'; END IF;
  SELECT role INTO actor_role FROM llenamos.memberships WHERE restaurant_id=rid AND uid=llenamos.actor_uid() AND active;
  IF actor_role IS NULL OR actor_role NOT IN ('owner','manager') THEN RAISE EXCEPTION 'settings_denied' USING ERRCODE='42501'; END IF;
  IF new_name IS NOT NULL AND char_length(clean_name) NOT BETWEEN 2 AND 80 THEN RAISE EXCEPTION 'settings_invalid_name' USING ERRCODE='22023'; END IF;
  IF new_color IS NOT NULL AND new_color !~ '^#[0-9a-fA-F]{6}$' THEN RAISE EXCEPTION 'settings_invalid_color' USING ERRCODE='22023'; END IF;
  IF new_locale IS NOT NULL AND new_locale NOT IN ('es','ca','en') THEN RAISE EXCEPTION 'settings_invalid_locale' USING ERRCODE='22023'; END IF;
  UPDATE llenamos.restaurants SET name=coalesce(clean_name,name),brand_color=coalesce(lower(new_color),brand_color),locale=coalesce(new_locale,locale),
    updated_by=llenamos.actor_uid(),updated_at=now() WHERE id=rid;
  IF NOT FOUND THEN RAISE EXCEPTION 'settings_missing' USING ERRCODE='P0002'; END IF;
END $$;
ALTER FUNCTION llenamos.restaurant_settings_save(text,text,text,text) OWNER TO llenamos_migrator;
REVOKE ALL ON FUNCTION llenamos.restaurant_settings_save(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION llenamos.restaurant_settings_save(text,text,text,text) TO llenamos_app;
