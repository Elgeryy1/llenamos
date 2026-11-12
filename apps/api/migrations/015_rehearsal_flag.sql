-- Marca de ensayo: la API y el worker leen platform_flags('rehearsal') para negarse a arrancar contra
-- la base equivocada. Migración propia porque 012 ya está aplicada y su huella no puede cambiar.
GRANT SELECT ON llenamos.platform_flags TO llenamos_app;
DROP POLICY IF EXISTS platform_flags_read ON llenamos.platform_flags;
CREATE POLICY platform_flags_read ON llenamos.platform_flags FOR SELECT TO llenamos_app USING(name='rehearsal');
-- La fila existe siempre (apagada por defecto): API y worker exigen verla. Si no la ven (sin permiso, sin política,
-- tabla ajena) se niegan a arrancar en vez de suponer «producción».
INSERT INTO llenamos.platform_flags(name,enabled) VALUES('rehearsal',false) ON CONFLICT(name) DO NOTHING;
