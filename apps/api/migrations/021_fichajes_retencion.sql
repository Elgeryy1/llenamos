-- 021 · Fichajes: se conservan 4 años y después se anonimizan (DECISIONES.md, 2026-11-12; art. 34.9 del Estatuto de los Trabajadores).
--
-- Los fichajes y sus eventos nunca se borran (el rol de ejecución no tiene DELETE). Lo único que se permite cambiar
-- en el libro de eventos es quitar la identidad, y solo de lo que ya pasó el plazo. Lo garantiza la base, no la aplicación.

GRANT UPDATE (doc) ON llenamos.staff_time_entry_events TO llenamos_app;
GRANT UPDATE (summary, details, actor_uid, actor_name) ON llenamos.fase4_activity TO llenamos_app;

CREATE FUNCTION llenamos.staff_retention_cutoff() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT to_char((current_date - interval '4 years')::date, 'YYYY-MM-DD') $$;

-- Eventos: solo se puede cambiar quién y el motivo, a «anonimizado», y de un fichaje de hace más de 4 años.
CREATE FUNCTION llenamos.staff_events_only_anonymize() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW.doc - 'uid' - 'by' - 'reason') IS DISTINCT FROM (OLD.doc - 'uid' - 'by' - 'reason')
     OR NEW.doc->>'uid' IS DISTINCT FROM 'anonimizado' OR NEW.doc->>'by' IS DISTINCT FROM 'anonimizado'
     OR (OLD.doc->>'reason' IS NULL) IS DISTINCT FROM (NEW.doc->>'reason' IS NULL)
     OR (NEW.doc->>'reason' IS NOT NULL AND NEW.doc->>'reason' <> 'anonimizado')
     OR NEW.restaurant_id <> OLD.restaurant_id OR NEW.location_id <> OLD.location_id OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'El libro de eventos de fichajes solo admite anonimizar.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM llenamos.staff_time_entries e WHERE e.restaurant_id = OLD.restaurant_id AND e.location_id = OLD.location_id
                 AND e.id = OLD.doc->>'entryId' AND e.entry_date < llenamos.staff_retention_cutoff()) THEN
    RAISE EXCEPTION 'El fichaje aún está dentro del plazo legal de conservación.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_events_only_anonymize BEFORE UPDATE ON llenamos.staff_time_entry_events
  FOR EACH ROW EXECUTE FUNCTION llenamos.staff_events_only_anonymize();

-- Fichajes: nadie los deja sin persona antes de tiempo. Pasar a «anonimizado» exige más de 4 años.
CREATE FUNCTION llenamos.staff_entries_anonymize_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.doc->>'uid' = 'anonimizado' AND OLD.doc->>'uid' <> 'anonimizado' AND OLD.entry_date >= llenamos.staff_retention_cutoff() THEN
    RAISE EXCEPTION 'El fichaje aún está dentro del plazo legal de conservación.' USING ERRCODE = '42501';
  END IF;
  IF OLD.doc->>'uid' = 'anonimizado' AND NEW.doc->>'uid' <> 'anonimizado' THEN
    RAISE EXCEPTION 'Un fichaje anonimizado no se vuelve a atribuir.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_entries_anonymize_guard BEFORE UPDATE ON llenamos.staff_time_entries
  FOR EACH ROW EXECUTE FUNCTION llenamos.staff_entries_anonymize_guard();

-- Actividad de personal: solo se puede dejar sin nombres, y solo la de más de 4 años. El resto de la actividad
-- (inventario, compras, exportaciones recientes, el propio aviso de anonimización) sigue siendo de solo añadir.
CREATE FUNCTION llenamos.fase4_activity_only_anonymize() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.action NOT LIKE 'staff.%' OR OLD.created_at >= (llenamos.staff_retention_cutoff())::date::timestamptz THEN
    RAISE EXCEPTION 'La actividad solo admite anonimizar la de personal pasado el plazo de conservación.' USING ERRCODE = '42501';
  END IF;
  IF NEW.summary IS DISTINCT FROM 'Registro anonimizado.' OR NEW.details IS DISTINCT FROM '{}'::jsonb OR NEW.actor_uid IS NOT NULL OR NEW.actor_name IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.restaurant_id <> OLD.restaurant_id OR NEW.location_id <> OLD.location_id OR NEW.action <> OLD.action OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'La actividad solo admite anonimizar.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fase4_activity_only_anonymize BEFORE UPDATE ON llenamos.fase4_activity
  FOR EACH ROW EXECUTE FUNCTION llenamos.fase4_activity_only_anonymize();

-- Turnos: pasado el plazo se anonimizan con la misma regla (un fichaje anonimizado no debe llevar a una persona por su turno).
CREATE FUNCTION llenamos.staff_shifts_anonymize_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.doc->>'uid' = 'anonimizado' AND OLD.doc->>'uid' <> 'anonimizado' AND (OLD.doc->>'date') >= llenamos.staff_retention_cutoff() THEN
    RAISE EXCEPTION 'El turno aún está dentro del plazo legal de conservación.' USING ERRCODE = '42501';
  END IF;
  IF OLD.doc->>'uid' = 'anonimizado' AND NEW.doc->>'uid' <> 'anonimizado' THEN
    RAISE EXCEPTION 'Un turno anonimizado no se vuelve a atribuir.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staff_shifts_anonymize_guard BEFORE UPDATE ON llenamos.staff_shifts
  FOR EACH ROW EXECUTE FUNCTION llenamos.staff_shifts_anonymize_guard();

-- Lo pendiente de anonimizar, por local, sin recorrer lo ya hecho ni lo reciente.
CREATE INDEX staff_entries_retention ON llenamos.staff_time_entries(restaurant_id,location_id,entry_date) WHERE (doc->>'uid') <> 'anonimizado';
CREATE INDEX staff_shifts_retention ON llenamos.staff_shifts(restaurant_id,location_id,(doc->>'date')) WHERE (doc->>'uid') <> 'anonimizado';
CREATE INDEX fase4_activity_retention ON llenamos.fase4_activity(restaurant_id,location_id,created_at) WHERE action LIKE 'staff.%' AND summary <> 'Registro anonimizado.';
