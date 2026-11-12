-- Sala (V4) lee el estado de la cuenta de caja (V5) para bloquear cambios sobre cuentas en cobro o saldadas,
-- también desde las operaciones públicas de mesa (solo SELECT y solo del local resuelto). Va después de
-- `009_caja.sql` por nombre.
CREATE POLICY sala_public_read ON llenamos.pos_bills FOR SELECT
  USING(restaurant_id=llenamos.sala_public_scope_id() AND location_id=llenamos.sala_public_location_id());
