# Fase 3 integrada

Recorrido local en `demo-llenamos`, rama `fase3/integracion`, con las cuentas de demo y los emuladores de la fila 5. Caja, impresión y móvil comparten el backend real. No hay claves reales, Stripe real, envíos a Hacienda ni impresora física. Todos los documentos fiscales conservan **no válido para Hacienda**.

## Repetir

Desde este worktree:

```bash
pnpm install --frozen-lockfile
pnpm fase3:preparar
pnpm funciones:build
npx firebase emulators:start --project demo-llenamos --config firebase.agente5.json
```

La preparación genera archivos locales excluidos de git. Auth 9106, Firestore 8100, Functions 5016, Storage 9216, Hub 4415, Logging 4515, Eventarc 9315, Tasks 9515 y web 3015. El websocket de Firestore ocupa 4015 y la UI queda apagada para no abrir puertos ajenos. No se usa el empaquetado aislado de las entregas anteriores.

En otra terminal, esperar a «All emulators ready» antes del seed:

```bash
export GCLOUD_PROJECT=demo-llenamos
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8100
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9106
export METADATA_SERVER_DETECTION=none
pnpm seed
pnpm seed:servicio
pnpm seed:caja
pnpm --filter web exec next dev --port 3015
```

Abrir `/entrar`, `propietario@lumbre.test`, contraseña `Llenamos2026!`. El recorrido automático se ejecuta en una tercera terminal con las mismas variables:

```bash
pnpm e2e:fase3
```

El script crea una mesa F3 y una reserva nuevas mediante el backend, usa formularios reales de comandero, cocina y caja, y conserva resultados saneados en [recorrido.json](recorrido.json). No intercepta las respuestas de Firebase. Bloquea las solicitudes externas del navegador. Solo oculta el indicador de desarrollo de Next en las capturas.

Para el pago móvil, la interfaz explica que falta proveedor y deshabilita continuar. La herramienta usa `startPayment` con un transporte de Checkout inyectado que devuelve una sesión de ejemplo, con importes y consentimiento elegidos en el móvil. Después manda cargas HMAC al webhook HTTP real: firma mala y caducada devuelven 400, buena y repetida 200. El webhook usa `confirmExternalPayment` e `issuePartInvoice` reales; no se escriben pagos, saldos ni facturas a mano. El transporte de ejemplo no habilita Stripe en la aplicación ni contacta con Stripe.

El puente es el proceso real `tools/print-bridge/bridge.mjs`, con archivo protegido y diario temporal. Envía a un servidor TCP falso en `127.0.0.2:9515`; Tasks sigue usando `127.0.0.1:9515`. El recorrido compara cada trabajo con los bytes recibidos, confirma sus estados y comprueba que volver a reclamar no reenvía. El script cierra servidor, puente y Chromium al terminar. Parar también los procesos de web y emuladores propios al acabar.

Si pnpm no puede escribir su gestor, crear `/tmp/llenamos-runtime` y usar `PNPM_HOME=/tmp/llenamos-pnpm XDG_RUNTIME_DIR=/tmp/llenamos-runtime`; la instalación de esta sesión usó `--store-dir /tmp/llenamos-store`. Firebase puede usar `XDG_CONFIG_HOME=/tmp/f3-config`. No son dependencias ni archivos de producto.

## Recorrido y capturas a 2x

Escritorio 1440 × 900 CSS, cocina en tableta 1180 × 820 y cliente/móvil 390 × 844. Los archivos tienen el doble de resolución; las capturas de página completa conservan toda su altura. Se comprueba que no hay desbordamiento horizontal. Los resúmenes de caja se adaptan a dos columnas para mantener legibles consumo, cobros y arqueo.

| Captura | Hecho comprobado |
|---|---|
| `01-reserva-sentada.png` | Crear reserva y sentarla abre una única sesión con tres comensales |
| `02-pedido-retenido.png` | Pedido desde el comandero: bravas, hamburguesa y agua; precios del servidor |
| `03-cocina-marchada.png` | Marchar todo genera comandas por estación y pase, enviadas por TCP |
| `04-cocina-lista.png` | La cuenta de cocina prepara y deja listos los platos |
| `05-invitacion-y-anulacion.png` | Invitación de 50 céntimos y anulación de 25, ambas con motivo |
| `06-partes-iguales.png` | Tres partes de 725 céntimos, guardadas sobre la revisión actual |
| `07-reparto-por-platos.png` | Reparto final: 575, 1400 y 200 céntimos; bloqueo del consumo |
| `08-efectivo-cambio-propina.png` | Primera parte en efectivo: 575 de consumo, 50 de propina, entrega 1000, cambio 375; ticket y cajón |
| `09-factura-completa.png` | F1 para la segunda parte, con datos ficticios del cliente y aviso fiscal |
| `10-tarjeta-externa.png` | El camarero registra los 1400 con referencia de datáfono; no se ejecuta cargo bancario |
| `11-mesa-enlace-cuenta.png` | El QR de mesa enlaza a la consulta de cuenta preparada |
| `12-partes-en-el-movil.png` | El cliente consulta las partes existentes sin poder cambiar el reparto |
| `13-propina-consentimiento-sin-claves.png` | Tercera parte con propina del 5 %, consentimiento y correo; pago deshabilitado sin proveedor |
| `14-pago-movil-confirmado.png` | Webhook firmado confirma una vez los 200 de consumo y 10 de propina |
| `15-recibo-privado.png` | Recibo del cobro anterior, con factura, QR original y advertencia fiscal |
| `16-permisos-camarero.png` | El camarero cobra; el backend rechaza rectificar y cerrar caja, y la pantalla limita gestión |
| `17-rectificativa.png` | R4 por diferencias de menos 100, referida a la F1; devolución separada |
| `18-servicio-cerrado.png` | Cerrar antes de pagar se rechaza; tras saldar y servir se cierra la sesión |
| `19-impresion-confirmada.png` | Proyección de trabajos confirmados por el puente, sin credenciales ni bytes |
| `20-arqueo-sin-diferencia.png` | Fondo 10000, efectivo esperado y contado 10625, diferencia cero |
| `21-arqueo-movil.png` | El cierre confirmado se consulta en móvil |
| `22-plan-sin-caja.png` | Sin `pos`, desaparecen Caja e Impresoras del menú y el backend rechaza operar |

Reintentos: efectivo con la misma intención devuelve el mismo pago y cambio; tarjeta con la misma intención del camarero devuelve el mismo resultado; webhook repetido conserva un único cobro externo; reclamar después de vaciar la cola no envía más bytes. Una reserva móvil impide cobrar esa misma parte por caja. El gasto del cliente sigue siendo consumo de sala y no se vuelve a sumar al cobrar. Las propinas quedan fuera del total fiscal. Los índices, credenciales, payloads, reservas y eventos móviles continúan privados.

## Comprobaciones

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:puente
TEST_FIREBASE_EMULATORS=1 pnpm --filter functions exec vitest run src/backend.integration.test.ts src/reservations.integration.test.ts --hookTimeout=60000
TEST_FIREBASE_EMULATORS=1 pnpm --filter functions exec vitest run --exclude src/backend.integration.test.ts --exclude src/reservations.integration.test.ts --hookTimeout=60000
```

Los dos bloques usan las variables de emulador anteriores. Las pruebas de reservas y actividad se ejecutan primero para no mezclar sus esperas de disparadores con la creación y limpieza de las suites de sala/caja. Functions: **215 pruebas correctas** entre ambos bloques, incluidas fase 2, fase 3, impresión, móvil y la prueba nueva que conecta las tres piezas. Las 11 pruebas antiguas R2 con indicadores de otra fila permanecen omitidas; no se abren sus puertos.

Parar primero los emuladores propios antes de ejecutar reglas, porque la suite arranca los mismos puertos y limpia los datos:

```bash
npx firebase emulators:exec --project demo-llenamos --config firebase.agente5.json --only firestore,storage "vitest run --root tests/rules"
```

Reglas: **98 pruebas correctas**, incluidas lecturas autorizadas y denegadas por rol, módulo, restaurante y local; denegación de altas, cambios y borrados cliente; protección de tokens, índices privados y artefactos de Storage. Puente TCP: **7 pruebas correctas**. Resultados resumidos en [comprobaciones.txt](comprobaciones.txt).

## Cambios y límites

Sin dependencias nuevas. Se exportan las tres piezas en `functions/src/index.ts`, se conectan los servicios de caja, se añaden índices y permisos comunes y el menú Impresoras. Caja muestra incidencias móviles de gestión y crea enlaces privados. El recibo y el pago llevan encabezados sin caché, sin referrer y sin indexación. El ticket automático al completar parte es opcional; un fallo de emisión conserva el cobro y permite emitir desde Facturar. La prueba cubre esa separación.

Contrato aditivo: `verMesaPublica.canViewPayment?` indica disponibilidad del acceso a la cuenta preparada según sesión y módulos. Se documentan las conexiones, la emisión separada del cobro y la excepción TCP local. No cambian firmas de caja, cálculos fiscales ni política de liberación de reservas de saldo. No se configura TTL ni se despliega nada.

Pendiente fuera del alcance local: proveedor fiscal productivo, decisiones fiscales y de receptor de fondos, Stripe real, proveedor de correo real y compatibilidad con impresora/cajón físicos. No se declara validez para Hacienda ni se presenta TCP como prueba de salida física de papel.

Cambios sin commit ni push. Mensaje propuesto: `Integra caja, impresión y pago móvil con recorrido completo en emuladores`.
