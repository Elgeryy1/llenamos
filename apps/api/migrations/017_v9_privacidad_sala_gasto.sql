-- Privacidad de `sala_spend` (gasto por cliente, 014): el worker puede borrar las filas de una persona.
-- Aclaración sobre 013: el `GRANT UPDATE` por columnas del worker en `reservation_origins` es redundante, porque
-- `llenamos_app` ya tiene UPDATE completo sobre esa tabla desde 011c y el worker es miembro de `llenamos_app`. No se
-- restringe aquí porque campañas (V7) actualiza esa tabla con el rol de la API; queda como permiso explícito del worker.
GRANT DELETE ON llenamos.sala_spend TO llenamos_worker;
