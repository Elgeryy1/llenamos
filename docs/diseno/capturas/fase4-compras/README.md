# Compras (fase 4, fila 4) · capturas

Capturas reales a 2x contra los emuladores (`demo-llenamos`), con `pnpm seed`, `pnpm seed:servicio` y el seed de la fase 4, entrando con `encargada@lumbre.test` (excepto la 40, con `cocina@lumbre.test`). Todo lo que se ve lo ha calculado y guardado el servidor: nada está simulado.

| Captura | Qué enseña |
|---|---|
| 01 | Proveedores y formatos: lista con contacto, plazo, pedido mínimo y formatos activos |
| 02 | Ficha de un proveedor con sus formatos, precio por kilo o litro y último precio pagado |
| 03 | Alta de un formato (ingrediente, cuánto trae, precio sin IVA, preferido) |
| 04 | Borrador preparado desde una sugerencia, con total y aviso de pedido mínimo |
| 05 | Borrador guardado: líneas, total y nota de que el proveedor aún no sabe nada |
| 06 | Texto del pedido para copiar (con o sin precios, completo o solo lo pendiente) |
| 07 | Confirmación de «enviado»: Llenamos no envía nada, lo marca el encargado |
| 08 | Pedido enviado, listo para recibir |
| 09 | Recepción con precio del albarán, aviso de cambio de precio y de formato recibido de más |
| 10 | Resultado de la recepción: total, cambios de precio con botón para actualizar el precio de lista, lo recibido de más |
| 11, 12 | Cerrar un pedido recibido en parte sin completar, con motivo |
| 13, 14 | Recibir mercancía sin pedido (compra directa) |
| 15 | Lista de pedidos con todos los estados y últimos albaranes |
| 20, 21 | Tableta: pedidos y detalle |
| 30 a 34 | Móvil: pedidos, detalle, recepción, proveedores y edición de un borrador |
| 40 | Cocina entra en Compras: sin permiso `compras.gestionar` no ve nada |
