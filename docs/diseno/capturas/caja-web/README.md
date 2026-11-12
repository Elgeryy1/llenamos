# Caja web · fila 2

Retomado desde `2072489` («Trabajo en curso»). Pantalla `/panel/caja`, diseño Sala cálida, controles de 48 px y desplegables propios. Sin dependencias nuevas, escrituras directas a Firestore, cambios de core, contrato, navegación o servidor.

## Qué incluye

- Mesas y para llevar reales de fase 2, búsqueda y cuentas en curso.
- Apertura, movimientos, arqueo con diferencia y motivo, cierre definitivo y reparto de propinas por minutos aprobados manualmente.
- Consumo congelado, invitaciones y anulaciones con motivo, división por partes iguales, platos completos o importes, preparación y desbloqueo autorizado.
- Efectivo con consumo, propina, entrega y cambio separados; accesos rápidos a billetes y entrega justa. Tarjeta como registro de un datáfono externo con referencia. Mixto mediante cobros parciales sucesivos. Aplicación de una señal ya pagada, comprobada por el servidor.
- Factura simplificada o completa con datos nacionales o extranjeros, historial de documentos y cobros, devoluciones parciales de consumo o solo propina, sustitución, rectificación y anulación fiscal motivada.
- Solicitud de prefactura o copia y proyección del estado de impresión. Una cola o envío incierto nunca aparece como impreso.
- Intención persistida en `sessionStorage` antes de enviar, con el mismo `requestId` al recargar y recuperar. Una respuesta incierta bloquea otras mutaciones de la pestaña. Sin conexión confirmada, las lecturas de caché no permiten cobrar.

Todas las llamadas usan los nombres y esquemas de `CALLABLE_SCHEMAS_FASE3`: `abrirCaja`, `cerrarCaja`, `registrarMovimientoCaja`, `abrirCuenta`, `verCuenta`, `ajustarCuenta`, `dividirCuenta`, `prepararCobro`, `desbloquearCuenta`, `registrarCobro`, `devolverCobro`, `emitirFactura`, `rectificarFactura`, `sustituirSimplificada`, `anularRegistroFiscal`, `repartirPropinas` y `solicitarImpresion`.

## Límite comprobado

Esta rama todavía no contiene las callables ni las reglas de caja de fase 3. Las lecturas denegadas y los intentos reales fallidos se muestran como tales. No se han creado cuentas, cobros, cierres o facturas ficticios para capturar la pantalla. Los formularios que requieren esos documentos están cubiertos con pruebas de componentes y datos de prueba explícitos, no con un servidor simulado en el producto.

El aviso «Proveedor de prueba: no válido para Hacienda» está en la pantalla, la emisión y cada documento del historial. No se envía nada a Hacienda. Sin `STRIPE_SECRET_KEY` no se cobra con Stripe; registrar un datáfono externo no ejecuta un cargo bancario. No hay pruebas con Stripe, Hacienda o una impresora físicos/reales.

Pendiente para integración: backend y reglas del agente 1, impresión del agente 3, navegación del coordinador y recorrido completo con cuentas, facturas y arqueos realmente emitidos. El camarero introduce la referencia de una caja abierta y de la impresora porque el contrato restringe la lectura de esas colecciones al encargado. Se copian desde el detalle del turno o la configuración de impresión. Los enlaces de pago y recibo digital pertenecen al agente 4.

## Reproducir en local

Desde este worktree, con Node y las dependencias existentes:

```sh
export XDG_DATA_HOME=/tmp/llenamos-pnpm
pnpm install
pnpm funciones:build
```

Copiar `firebase.json` a `firebase.agente2.json` (excluido de git), con Auth 9103, Firestore 8097, Functions 5013, Storage 9213, UI 4012, Hub 4412, Logging 4512, Eventarc 9312 y Tasks 9512. Copiar `apps/web/.env.example` a `.env.local` y fijar esos cuatro puertos públicos de emuladores, host `127.0.0.1` y origen `http://localhost:3012`.

```sh
XDG_CONFIG_HOME=/tmp/llenamos-caja-config npx firebase emulators:start --project demo-llenamos --config firebase.agente2.json
```

`XDG_CONFIG_HOME` vacío evita que la CLI use cuentas o intente escribir credenciales fuera del sandbox. En otra terminal:

```sh
export GCLOUD_PROJECT=demo-llenamos
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8097
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103
pnpm seed
pnpm seed:servicio
node docs/diseno/capturas/caja-web/preparar.mjs
pnpm --filter web exec next dev --port 3012
```

`preparar.mjs` activa `pos` por `cambiarPlan` con la cuenta local LogiQD, abre una mesa, envía dos raciones y crea una recogida con las callables reales de fase 2. No prepara datos de fase 3. Requiere una franja de recogida disponible en el día de la demo; si no existe, lo explica.

Entrar por `/entrar` como `propietario@lumbre.test` o `camarero@lumbre.test`, contraseña `Llenamos2026!`, y visitar directamente `/panel/caja`. No existe aún una entrada en el menú.

```sh
node docs/diseno/capturas/caja-web/capturar.mjs
```

El capturador usa Playwright existente, con alternativa en `/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright`, y Chromium local. No instala nada ni intercepta respuestas de Firebase.

## Capturas reales a 2x

| Tamaño CSS | Archivos | Qué demuestra |
|---|---|---|
| 1440 × 900 | `escritorio-cuentas.png`, `escritorio-para-llevar.png` | Mesa y recogida reales; permiso de caja pendiente de integrar |
| 1440 × 900 | `escritorio-apertura.png`, `escritorio-backend-ausente.png`, `escritorio-historial.png` | Formulario, intento fallido real y recuperación de la misma intención tras recargar y reintentar |
| 1180 × 820 | `tableta-cuentas.png`, `tableta-desplegable.png`, `tableta-apertura.png`, `tableta-backend-ausente.png` | Vista partida, selector propio y llamada real a `abrirCuenta` para llevar sin éxito inventado |
| 390 × 844 | `movil-cuentas.png`, `movil-desplegable.png`, `movil-apertura.png`, `movil-backend-ausente.png` | Una columna, selección táctil, apertura y backend ausente |
| 390 × 844 | `movil-permisos-camarero.png` | El camarero no puede abrir, arquear o cerrar caja |

Sin desbordamiento horizontal en los tres tamaños y sin errores de página en la ejecución final. La altura de las capturas completas puede superar la ventana.

## Comprobaciones del 9 de noviembre de 2026

- `pnpm lint && pnpm typecheck && pnpm test && pnpm build`: en verde. Core 373 pruebas; web 463; funciones unitarias 69. Las pruebas que requieren emuladores se omiten en la ejecución ordinaria.
- Caja: 24 pruebas unitarias y de componentes, más 3 de integración HTTP con Auth y Functions reales. Cubren cambio, cobro parcial, datáfono, rechazo de sobrecobro, fallos de conexión, recuperación idempotente, importes exactos, reparto de menús y céntimos, destinatarios, emisión duplicada, selección de una segunda parte y devoluciones con saldo ya reservado.
- Functions con `TEST_FIREBASE_EMULATORS=1`, `GCLOUD_PROJECT=demo-llenamos`, `FIRESTORE_EMULATOR_HOST=127.0.0.1:8097` y `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103`: 102 pruebas pasan; 11 de la bandera independiente `TEST_R2_EMULATORS` se omiten. No demuestra el backend de caja aún ausente.
- El intento adicional con `TEST_R2_EMULATORS=1` terminó por señal 143 sin resultado completo; no se cuenta como validación. No se modifican servidor ni reglas. La ejecución adicional de reglas con `emulators:exec` encontró los puertos aún ocupados y no llegó a correr las pruebas.
- Aviso preexistente de tamaño de un fragmento de landing durante build; build finaliza correctamente.

## Entrada de menú para el coordinador

```json
{
  "section": "caja",
  "href": "/panel/caja",
  "label": "Caja",
  "group": "servicio",
  "permission": "caja.ver",
  "module": "pos",
  "icon": "CashRegisterIcon"
}
```

Añadir `caja` a `PanelSection` y su icono al mapa compartido. La página comprueba permisos, `pos` y, para cuentas nuevas, `floor`. Se entregan estos datos sin modificar `lib/panel/nav.ts`.

Mensaje de commit propuesto:

```text
Completa la pantalla de caja con cobros, arqueo e historial

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Cambios dejados en el worktree, sin commit ni push.

Incidencia al terminar: se interrumpieron las sesiones de web y emuladores, y Firestore se detuvo por su endpoint local de cierre. Persisten escuchas de web 3012 y de los demás servicios de la fila 2. Cada ejecución del sandbox tiene su propio espacio de PID: el hub informa PID 15, pero `kill -TERM 15` desde otra ejecución responde «No such process». No se ha podido completar su cierre desde estas herramientas. El coordinador debe liberar estos procesos desde el host antes de reutilizar la fila 2. No se han parado servicios de otras filas.
