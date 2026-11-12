# Fase 3 · Caja y tickets legales · reparto entre agentes

Objetivo: cobrar en el restaurante de punta a punta y con tickets legales. Cobro en efectivo y tarjeta, pagos parciales, dividir la cuenta, invitaciones y anulaciones con motivo; apertura y cierre de caja con arqueo; factura simplificada y completa con **Verifactu y TicketBAI** detrás de un adaptador; impresión de comandas y tickets en impresora térmica (ESC/POS) y cajón; pago desde el móvil del cliente (Stripe) y recibo digital; propinas y su reparto por horas trabajadas. Módulo `pos`.

Reglas de siempre: todo en local con los emuladores, dinero en céntimos enteros, importes y totales calculados en el servidor, nada simulado como si fuera real. **Sin proveedor de Verifactu elegido** (decisión 3 de `PLAN.md`), el adaptador trae un proveedor de prueba marcado de forma visible como «no válido para Hacienda»: genera la huella, el encadenamiento y el QR con el formato oficial para poder probar, pero no envía nada. Stripe y las impresoras igual: sin claves o sin impresora, se dice claramente.

## Orden

1. **Contrato** (`fase3/contrato`, un agente, primero): sección «Fase 3 · Caja» de `ARQUITECTURA.md` y `packages/core` (`caja/`): datos, callables, reglas, permisos, estados, lógica pura con pruebas (cuenta y sus partes, división por partes iguales, por platos o por importe, redondeo al céntimo sin perder ni ganar, IVA por tipo incluido en el precio, invitaciones y anulaciones, arqueo, propinas y reparto, numeración de series sin huecos, registro de facturación Verifactu: huella SHA-256 encadenada, QR de cotejo, anulación y rectificativa; formato ESC/POS de comanda y ticket). Al final, cómo repartir la fase 3 sin pisarse.
2. En paralelo, tras el contrato: backend de caja y Verifactu, pantalla de caja y cobro, impresión (puente local de impresora y cola de impresión) y pago desde el móvil con recibo digital.
3. Integración y prueba de punta a punta (coordinador).

Puertos, reglas comunes y normas: las de `docs/tareas/etapa-0-reparto.md`.

## Contrato entregado y orden de integración

El punto 1 queda definido en **ARQUITECTURA.md, «Fase 3 · Caja»**, y exportado desde `@llenamos/core`: `caja/`, `api-caja.ts`, permisos de `roles.ts` y congelación del IVA en líneas/borradores de fase 2. Incluye cuenta, ajustes, reparto exacto, cobros y devoluciones, arqueo, propinas, series, factura, registros de alta/anulación, hash/QR/XML, `FiscalProvider`, proveedor local y formato ESC/POS. Las pruebas de huella reproducen los tres vectores oficiales de AEAT. No implica backend ni pantallas implementados, envío a Hacienda, validación de proveedor productivo o prueba con impresora real.

Los cuatro agentes parten de `main` **después de integrar el contrato**. Puertos: filas 1 a 4 de etapa 0; no se usa la fila del coordinador. No cambian core ni firmas por su cuenta. El coordinador centraliza ajustes de contrato y conecta exportaciones de cada carpeta, navegación, enlaces públicos, paquetes y scripts comunes.

Interfaces que evitan que los agentes se pisen:

- El backend publica `functions/src/fase3/service.ts` con `confirmExternalPayment(ConfirmedExternalPayment)` y `issuePartInvoice(CallableParsedInput<"emitirFactura">, actorUid)`, con las firmas completas y garantías de ARQUITECTURA.md. Móvil las importa para no mantener otro libro de cobros ni otra emisión fiscal.
- Caja crea documentos `PrintRequest` durables con id determinista. Impresión los consume y escribe trabajos/proyección `PrintStatus`, sin tocar el servicio de caja. El puente no recibe bytes del público y no reintenta automáticamente un envío incierto.
- Impresión y móvil exportan sus funciones desde un `index.ts` de carpeta. Sus reglas e índices necesarios los implementa el agente 1 conforme al contrato; no editan `firebase/**` en paralelo.
- Backend integra el bloqueo de caja en **todas** las mutaciones de fase 2 que cambien el consumo, el destino o el cierre, y pasa la carta de menús como quinto argumento de `planOrderLines` para congelar IVA. Los frontends no lo resuelven ocultando botones.

Integración: backend → impresión → caja web → móvil. El coordinador recorre mesa y para llevar, cuentas divididas y pagos parciales mixtos, fiscalidad, copias de ticket, recibo digital, arqueo, devoluciones y reintentos. Cada agente entrega pruebas comunes; backend además reglas y emuladores, móvil firmas/eventos de prueba con fetch inyectado. Nadie contacta Stripe real ni Hacienda; proveedor local siempre visible como «no válido para Hacienda».

Decisiones pendientes del usuario con recomendación: proveedor fiscal con declaración responsable y soporte foral; validar anticipos e invitaciones con ese proveedor antes de producción; comenzar con impresora ESC/POS de 80 mm y puente local; camarero cobra y encargado rectifica/cierra; reparto de propinas por minutos aprobados. Los detalles fiscales y territoriales que faltan están marcados como **«a confirmar con el proveedor»** en el contrato. No bloquean las pruebas locales.

## Propiedad exclusiva para el trabajo en paralelo

| Agente / rama | Carpetas y archivos propios | Encargo |
|---|---|---|
| 1 · `fase3/backend` | `functions/src/fase3/**`, integración de `functions/src/fase2/**` y reservas, `firebase/**`, `tests/rules/fase3*`, `scripts/seed-fase3.ts` y procesador fiscal local | 17 callables de caja/fiscalidad, servicios para móvil, transacciones, bloqueo con sala, reglas e índices de toda la fase, seed y remisión fiscal |
| 2 · `fase3/caja-web` | `apps/web/src/app/(personal)/panel/caja/**`, `components/caja/**`, `lib/caja/**` | caja, arqueo, reparto/cobro, facturas/correcciones, propinas y avisos; componentes y lib bajo `apps/web/src/` |
| 3 · `fase3/impresion` | `functions/src/fase3-print/**`, `tools/print-bridge/**`, `apps/web/src/app/(personal)/panel/impresoras/**`, `components/impresion/**`, `lib/impresion/**`, `scripts/impresion-*.ts` | cinco callables de impresora/puente, peticiones/cola/leases, ESC/POS, comanda/ticket/copia/cajón; componentes y lib bajo `apps/web/src/` |
| 4 · `fase3/pago-movil` | `functions/src/fase3-mobile/**`, `apps/web/src/app/p/**`, `app/recibo/**`, `components/pago-movil/**`, `lib/pago-movil/**`, `scripts/pago-movil-*.ts` | cinco callables de pago/recibo, `stripeCuentaWebhook`, reconciliación y correo; app/componentes/lib bajo `apps/web/src/` |
| Coordinador | `functions/src/index.ts`, menú y enlaces compartidos de web, `package.json`, lockfile, configuración Firebase, CI, contrato/core, documentación y `PLAN.md` | integra exportaciones, comandos y cambios compartidos, verifica el recorrido completo y hace commit/push; nadie los modifica en paralelo |
