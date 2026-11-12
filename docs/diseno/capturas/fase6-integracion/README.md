# Fase 6 integrada · capturas

Chromium real a 2x contra los emuladores de la fila 5 y la web de producción local (`next start`, puerto 3015). Sin Stripe real, sin red y sin cargos. Se generan con `pnpm exec tsx scripts/fase6-integracion-navegador.ts` (emuladores con funciones, `pnpm seed` y la web en marcha). El resultado, sin errores de página, queda en `resultado.json`.

| Captura | Qué enseña |
|---|---|
| 01, 02 | Enlace discreto a `/alta` en la página de inicio y en la de entrar |
| 03, 04 | Alta de un restaurante nuevo: prueba gratis sin tarjeta y restaurante creado |
| 05 | Menú con «Plan y facturación», «Integraciones» y «Privacidad» |
| 06 | Prueba gratuita; sin claves de Stripe no se cobra y se dice |
| 07 | Cambio de plan con Stripe simulado (factura pagada del catálogo) |
| 08, 09 | Clave de API y webhook creados desde la pantalla; entrega recibida por un receptor local con firma válida |
| 10, 11, 12, 13 | Impago: siete días de gracia, después el servicio se pausa (reservas), el plan sigue visible; también en móvil |
| 14 | Privacidad |
| 15, 16 | Quien tiene el claim `logiqd` ve «Equipo LogiQD» en el menú de la cuenta y entra en `/logiqd` |

La prueba de integración de functions con los mismos pasos (más caja, exportar y borrar un cliente y simulacro de restauración) es `functions/src/fase6-integracion.integration.test.ts`.
