# Integración local de fase 5

2026-11-10. Chromium, capturas a 2x. Proyecto demo-llenamos, fila 2: Auth 9103, Firestore 8097, Functions 5013, Storage 9213 y web 3012. Repite usa su doble HTTP local. Sin pagos ni mensajes externos.

Recorrido: la reserva y la baja se hacen con la interfaz pública; las operaciones de personal usan las callables HTTP reales desde Chromium. Las pantallas se capturan con su sesión y datos reales, sin interceptar respuestas de Firebase ni del producto. Solo el contenedor HTML del widget es un fixture. Los datos auxiliares y las doce semanas del seed están identificados como demostración.

- [01-reserva-consentimiento-movil.png](01-reserva-consentimiento-movil.png): Reserva pública móvil con origen de campaña y permiso opcional por correo.
- [02-reserva-confirmada.png](02-reserva-confirmada.png): Reserva creada por la interfaz pública y confirmada por el servidor.
- [03-cliente-puntos-repite.png](03-cliente-puntos-repite.png): Ficha integrada con alta de puntos y un sello confirmado en el doble local de Repite.
- [03b-tarjeta-repite.png](03b-tarjeta-repite.png): Tarjeta con un sello confirmado por el doble de Repite en la ficha de cliente.
- [04-cuenta-promocion.png](04-cuenta-promocion.png): Cuenta real con la promoción calculada por el servidor y ajustes rotulados como descuento.
- [05-baja-movil.png](05-baja-movil.png): Baja desde el enlace del mensaje real capturado y cancelación del envío pendiente.
- [06-informe-origen.png](06-informe-origen.png): Informe de origen real de reservas y ventas de la campaña.
- [07-ventas-comparativa-margen.png](07-ventas-comparativa-margen.png): Panel de ventas con comparativa y margen, sobre cuentas y costes históricos reales del emulador.
- [08-prevision.png](08-prevision.png): Previsión con muestras de doce semanas del seed de fase 5.
- [09-resumen-diario.png](09-resumen-diario.png): Resumen diario preparado por el trabajador real y capturado sin envío externo.
- [10-recomendacion.png](10-recomendacion.png): Automatización que recomienda pedir señal y no ejecuta ninguna acción.
- [11-menu-propietario.png](11-menu-propietario.png): Menú real de propietario con el plan completo.
- [11-menu-encargada.png](11-menu-encargada.png): Menú real de encargada con el plan completo.
- [11-menu-camarero.png](11-menu-camarero.png): Menú real de camarero con el plan completo.
- [11-menu-cocina.png](11-menu-cocina.png): Menú real de cocina con el plan completo.
- [11-menu-barra.png](11-menu-barra.png): Menú real de barra con el plan completo.
- [12-menu-plan-sala.png](12-menu-plan-sala.png): Plan sala sin entradas de la fase 5.
- [13-privacidad.png](13-privacidad.png): Solicitud de privacidad completada, cuenta de puntos cerrada y borrado Repite encolado.
- [14-fidelizacion-escritorio.png](14-fidelizacion-escritorio.png): Programa y premios con datos del servidor.
- [15-analisis-tableta.png](15-analisis-tableta.png): Análisis a 1180 × 820, capturado a 2x.
- [16-campanas-movil.png](16-campanas-movil.png): Campañas reales en móvil, sin datos de ejemplo por defecto.
- [17-widget-tableta.png](17-widget-tableta.png): Widget real montado con widget.js en un contenedor de prueba, permiso opcional desmarcado inicialmente y atribución del padre.

Preparación: [backend y emuladores](../../../../functions/src/fase5/README.md). Comprobaciones del cierre: [COMPROBACIONES.md](COMPROBACIONES.md).

Resultado de las aserciones: [resultado.json](resultado.json). Script: [fase5-navegador-integracion.ts](../../../../scripts/fase5-navegador-integracion.ts). Ejecutar tras los seeds mediante `pnpm exec tsx scripts/fase5-verificar.ts pnpm exec tsx scripts/fase5-navegador-integracion.ts`. Los procesos programados se invocan con su mismo trabajador local; los sellos, puntos, devolución y mensajes usan los disparadores reales de Functions.
