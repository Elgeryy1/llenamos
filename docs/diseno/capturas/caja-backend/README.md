# Pruebas del backend de caja

Fecha: 9 de noviembre de 2026. Worktree `f3-backend`, rama `fase3/backend`, retomado desde `665473b` («Trabajo en curso»). Proyecto exclusivo `demo-llenamos`; fila 3: Auth 9104, Firestore 8098, Functions 5014 y Storage 9214. Web 3013. No se han usado Stripe ni Hacienda reales. **Proveedor fiscal de prueba: no válido para Hacienda.**

Esta entrega cubre las **17 callables propias** de la fila «Backend de caja y fiscal», según la tabla final del reparto. Las otras diez callables pertenecen a impresión y pago móvil. Se entregan los dos servicios transaccionales que necesita móvil y las peticiones durables que necesita impresión. No se ha modificado `packages/core`, `api-caja.ts`, el índice común de funciones ni código de la web. Sin dependencias nuevas y sin cambios del contrato congelado.

## Recorrido real en Chromium

Se cargaron `pnpm seed`, `pnpm seed:servicio` y `scripts/seed-fase3.ts`. Chromium entró por `/entrar` con `propietario@lumbre.test` y contraseña `Llenamos2026!`. El script [browser-check.mjs](../../../../functions/src/fase3/browser-check.mjs) ejecutó 24 llamadas HTTP desde el navegador contra Functions 5014, utilizando Auth 9104. La interfaz utilizada para comprobar el cierre es el comandero existente; la pantalla de caja es propiedad de otra fila y no se ha sustituido con una maqueta.

Resultado conservado en [recorrido-http.json](recorrido-http.json), sin tokens ni credenciales:

| Paso | Resultado comprobado |
|---|---|
| Abrir mesa y enviar dos raciones de bravas | Precio calculado en servidor: 1300 céntimos, IVA congelado |
| Invitación y anulación con motivo | Reducciones de 50 y 25 céntimos; cuenta de 1225 |
| Reparto | Iguales entre tres, después por platos y finalmente importes de 500 y 725 |
| Preparar cobro y servir | Revisión congelada; servir sigue permitido y no altera el saldo |
| Cerrar antes de pagar | HTTP rechaza y el comandero muestra «Salda la cuenta antes de cerrar la mesa» |
| Cobro parcial en efectivo | Consumo 200, propina 50, entrega 500, cambio 250 |
| Reintentar la misma petición | Mismo `paymentId`, cambio y saldo; no añade otro pago |
| Tarjeta | Registro manual de 300 con referencia de datáfono; sin llamada bancaria |
| Dos cobros concurrentes de los 725 restantes | Uno aceptado y otro rechazado; total cobrado 1225 |
| Facturas | Una F2 y una F1, ambas con aviso «no válido para Hacienda» |
| Devolución y rectificación | 100 céntimos devueltos, R5 por diferencias de menos 100; cuenta sigue saldada |
| Entradas y salidas | Entrada 300 y salida 200, con motivo |
| Arqueo | Fondo 10000, esperado y contado 10975; diferencia cero |
| Propinas | 50 céntimos conservados: 33 al camarero y 17 a la propietaria, según 120 y 60 minutos |
| Cerrar después del cobro | HTTP confirma `closed`; el comandero muestra la mesa cerrada |

Las series ya tenían emisiones de una ejecución anterior del recorrido. El resultado conserva los siguientes números F/000003, F/000004 y R/000002; repetir el seed no reinició los correlativos ni borró facturas previas.

## Capturas a 2x

- [01-cierre-bloqueado.png](01-cierre-bloqueado.png): 1440 × 900 CSS, archivo 2880 × 1800. Rechazo real al intentar cerrar con saldo pendiente.
- [02-cierre-tras-cobro.png](02-cierre-tras-cobro.png): 1440 × 900 CSS, archivo 2880 × 1800. La misma sesión cerrada después de saldar, con las líneas servidas.
- [03-cierre-movil.png](03-cierre-movil.png): 390 × 844 CSS, archivo 780 × 1688. Estado cerrado desde el móvil.

Los importes del resumen del comandero son consumo de sala, como en fase 2; no se presentan como ingresos fiscales. El detalle de cobros y arqueo está en el resultado HTTP y en las colecciones privadas correspondientes. Las capturas no acreditan impresión física ni pagos bancarios.

## Comprobaciones

- `pnpm install --frozen-lockfile` y `pnpm funciones:build` correctos.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` correctos. Pruebas unitarias: core 373, funciones 72 y web 439, total 884. Las suites que requieren emuladores se ejecutan aparte.
- Integración de caja: apertura y petición idempotentes, revisión obsoleta, saldo reservado, dos cobros y dos devoluciones simultáneos, caja cerrada, efectivo/cambio/datáfono/propina, invitación/anulación y permisos, cuenta por destino, factura por parte, simplificada/completa/F3 y R por I/S, numeración y cadena compartida entre locales, rechazo fiscal y subsanación sin nuevo número, timeout conservando XML, detección de manipulación, dos trabajadores fiscales, señal parcial, QR bloqueado, IVA de menú, cierre y recogida con cuenta saldada, gasto sin duplicados y compatibilidad con `pos` apagado.
- Suite de funciones con emuladores: **134 pruebas correctas**, incluidas **29 de integración de caja**. Primer bloque: 6 de reservas y actividad; segundo: 128 del resto. Las 11 pruebas R2 fijadas a otra fila permanecen omitidas. Ambos bloques terminaron con código 0 y los emuladores se cerraron correctamente. Resumen ejecutado en [comprobaciones.txt](comprobaciones.txt).
- Reglas: **91 pruebas correctas** con `npx firebase emulators:exec --project demo-llenamos --config firebase.agente3.json --only firestore,storage "vitest run --root tests/rules"`. Incluyen acceso por rol/módulo/local y rechazo de altas, cambios y borrados del libro fiscal, instalaciones globales, credenciales, payloads y colecciones privadas.
- `git diff --check` correcto. No se ha hecho commit ni push.

Las primeras ejecuciones amplias encontraron esperas de detección de credenciales, de limpieza y de actividad de pruebas antiguas después del volumen de eventos de las suites nuevas. Para la repetición local se usa `METADATA_SERVER_DETECTION=none` y `--hookTimeout=60000`, ejecutando primero reservas/actividad y después el resto, sin relajar ninguna aserción funcional ni modificar esas suites. Los servicios siguen siendo exclusivamente los emulados de la fila 3. Las suites antiguas R2 fijadas a puertos de otra fila se omiten y no se han arrancado esos puertos.

## Repetir e integrar

La preparación del paquete local de Functions, la configuración excluida de git, los comandos de seed, prueba y procesador fiscal están en [functions/src/fase3/README.md](../../../../functions/src/fase3/README.md). Usar `METADATA_SERVER_DETECTION=none` en las terminales de prueba y emuladores evita la detección innecesaria de credenciales de nube.

El coordinador debe integrar las 17 exportaciones desde `functions/src/fase3/index.ts` en `functions/src/index.ts`, junto con las exportaciones de impresión y móvil de sus filas. Esta prueba usa `emulator-entry.ts` y un paquete generado y excluido de git en `.firebase/fase3/`. El directorio generado `functions/lib-caja/` del commit heredado no es la entrada validada ni debe publicarse como fuente.

La fiscalidad real continúa pendiente del proveedor elegido, también TicketBAI, anticipos reales, invitaciones y conservación/restauración reglamentaria. Sin adaptador bancario no se declara realizada una devolución Stripe o de señal; la respuesta es `not_configured`. El seed mantiene desactivado el pago móvil, no se añade ninguna clave y esta entrega no ejecuta cargos Stripe. El reparto físico y la subsanación técnica tienen servicios internos autenticados, sin añadir callables a core.

Mensaje de commit propuesto: `Completa el backend de caja y fiscal de prueba con integración y concurrencia verificadas`.
