# Capturas de fidelización, promociones y Repite

Capturas reales de Chromium sobre `http://localhost:3012`, con Auth 9103 y Firestore 8097 de `demo-llenamos`, tras `pnpm seed` y `pnpm seed:servicio`. Para revisar se habilitaron los módulos de fase 5 solo en ese emulador. No se ha contactado con Repite ni con otros servicios reales.

Todas están a **2x**, PNG de página completa:

| Prefijo | Ventana CSS | Tamaño de imagen |
| --- | --- | --- |
| `escritorio` | 1440 × 900 | 2880 px de ancho |
| `tableta` | 1180 × 820, táctil | 2360 px de ancho |
| `movil` | 390 × 844, táctil | 780 px de ancho |

Para cada tamaño:

- `cliente-cuenta`: `FichaFidelizacion` y `DescuentosCuenta` montadas en la demo.
- `sin-backend`: intento de aplicar una promoción de ejemplo, rechazado sin confirmar éxito.
- `programa`: ajustes de puntos y catálogo de premios de ejemplo.
- `promociones-editor`: lista y editor con franja de 22:00 a 02:00, cupos y compatibilidad.
- `repite`: ajustes e informe no conectado.
- `ruta-real`: la ruta de trabajo consulta Firestore real y explica que faltan las reglas o el acceso.

`movil-camarero.png` usa la sesión real de `camarero@lumbre.test`: puede solicitar el canje pero no configurar. La demo rechaza la escritura y lo dice. Los otros archivos usan `propietario@lumbre.test`.

**Los datos comerciales de la demo son fixtures identificadas**, no datos guardados por el backend. Esta rama no incluye el backend de fase 5. La demo nunca confirma un guardado, descuento, canje o sello. Las rutas reales no cambian a datos ficticios cuando falla una lectura.

Reproducir, con web y emuladores de la fila 2 arrancados:

```sh
node apps/web/src/lib/fidelizacion/capturas.mjs
```

El script comprueba ausencia de desbordamiento horizontal y errores de ejecución, verifica el rechazo de escrituras y los permisos del camarero y escribe `resultado.json`. Se oculta solo el indicador de desarrollo de Next para que no tape la interfaz.

Montaje, props, menú y pendientes: [informe de integración](../../../../apps/web/src/components/fidelizacion/README.md).
