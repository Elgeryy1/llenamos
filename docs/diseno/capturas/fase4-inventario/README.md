# Fase 4 · Inventario y escandallos · capturas

Hechas a 2x con Playwright contra los emuladores reales (proyecto `demo-llenamos`, fila 3 de puertos), con `pnpm seed`, `pnpm seed:servicio` y `scripts/seed-fase4.ts`, y con ventas reales hechas por las callables de sala (abrir mesa, enviar pedido, marchar, preparar, anular) para que el histórico tenga datos. Cuentas de demostración: `encargada@lumbre.test` (encargado), `cocina@lumbre.test` y `barra@lumbre.test`. Escritorio 1440 de ancho, tableta 1180×820 y móvil 390×844.

| Archivo | Qué enseña |
|---|---|
| `01-existencias-escritorio` | Existencias con resumen, valor del almacén (solo con costes), aviso de stock bajo y filas con merma, ajuste y «marcar visto» |
| `02-ajuste` | Ajuste manual con motivo (sumar, restar o devolver al proveedor) |
| `03-ingredientes`, `04-ingrediente-nuevo` | Lista de ingredientes y alta con existencias de partida |
| `05` a `08` | Recuento por pasos: elegir qué contar, contar, revisar con lo vendido mientras se contaba (reconciliación) y resultado aplicado |
| `09-movimientos` | Libro de movimientos con valor, autor y motivo |
| `10-escandallos-platos` | Coste teórico y margen por plato y variante |
| `11-receta-editor`, `12-receta-versiones` | Editor de receta con coste en vivo, extras y versiones (versión 2 tras cambiar una cantidad) |
| `13-margen-vendido` | Margen histórico del periodo con el coste de cada momento y la pérdida por anulaciones |
| `14` a `16` | Cocina: existencias sin ningún importe, merma y rutas de costes bloqueadas |
| `17`, `18` | Barra en móvil: existencias y merma |
| `19` | Tableta (encargado) |
| `20`, `21` | Móvil (encargado): escandallos y recuento |
| `acceso-cocina-barra.txt` | Lecturas directas a Firestore con la sesión de cocina y de barra: `ingredients` y `stockAlerts` dan 200; costes, movimientos, recetas, costes de línea, recuentos, proveedores y pedidos dan 403 |

Prueba de que cocina y barra no ven costes: (1) la web no pide `ingredientCosts` ni enseña un solo importe (el texto de la pantalla no contiene «€» y no hay pestañas de movimientos, recuento, ajustes ni escandallos); (2) las reglas de Firestore lo rechazan aunque se salte la web (`acceso-cocina-barra.txt`); (3) pruebas de Vitest en `apps/web/src/components/inventario/Existencias.test.tsx`.
