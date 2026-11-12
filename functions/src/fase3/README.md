> Integrado en la entrada común de Functions junto con móvil e impresión. Basta `pnpm funciones:build`; el recorrido y los puertos de integración están en [fase 3](../../../docs/diseno/capturas/fase3/README.md). Los pasos de empaquetado local siguientes conservan la entrega de origen.

# Backend de caja y fiscal de prueba

Esta fila entrega las **17 callables de caja y fiscalidad** del reparto final de fase 3. Las cinco de impresión y las cinco de móvil pertenecen a otras filas. Se mantienen core y las 27 firmas de `api-caja.ts` sin modificaciones. No hay dependencias nuevas.

Todo el proveedor fiscal se limita a `demo-llenamos` con Firestore emulado. Cada factura conserva el artefacto original, `validForTaxAuthority: false` y **«no válido para Hacienda»**. Registrar tarjeta significa anotación manual del datáfono, con referencia obligatoria. Este backend no contacta Stripe ni Hacienda y no declara realizados los reembolsos bancarios sin adaptador.

## Integración por el coordinador

`functions/src/index.ts` es propiedad del coordinador. Debe reexportar los 17 nombres de `functions/src/fase3/index.ts`. El `emulator-entry.ts` de esta carpeta sirve para probarlos junto con todas las funciones existentes sin editar ese archivo compartido. Los artefactos heredados del commit de trabajo en `functions/lib-caja/` no son la entrada de despliegue ni deben usarse para validar las fuentes actuales.

Móvil importa exclusivamente `confirmExternalPayment` e `issuePartInvoice` de `service.ts`. El primero exige el Checkout guardado, EUR, importe, propina, revisión, caja abierta y reserva de saldo coincidentes; deduplica por identificador externo, incluso con otro `requestId`. El segundo permite autor nulo únicamente para un Checkout pagado con el destinatario congelado. Se conservan metadatos privados adicionales del Checkout al actualizar su estado.

Impresión consume `printRequests` durables de factura y cajón con identificadores deterministas y `printerId: null`. Ningún fallo de impresión revierte un cobro ni genera otro número fiscal. Las reglas e índices de las tres filas de backend ya están en `firebase/`.

## Invariantes implementados

- Intención por local, autor, operación y `requestId`. La misma entrada devuelve su resultado original; otra entrada con la misma clave devuelve `already-exists`. Datos, intención, libro y actividad se confirman en una transacción.
- Bloqueo compartido `reservationLocks/current` con fases 1 y 2. Todas las escrituras de líneas y destinos pasan por la comprobación de cuenta bloqueada o saldada. Preparar cobro refresca consumo, invalida reparto obsoleto y conserva una revisión estable durante los cobros parciales.
- Cuenta única por destino y factura única por parte. El reparto conserva cada céntimo y mueve menú y suplementos juntos. Las líneas conservan el IVA del momento del pedido; un histórico sin IVA se rechaza y requiere migración documentada.
- Reservas de pago excluyen cobros competidores aunque haya vencido su reloj local. Cerrar caja exige reconciliar pagos pendientes. El cierre de mesa y la recogida exigen saldo cero cuando `pos` está activo, sin alterar el servicio anterior cuando está apagado. Pagar no sirve platos ni libera mesas y no vuelve a sumar gasto del cliente.
- Devoluciones inmutables referidas al cobro exacto, incluidos límites concurrentes de consumo y propina. Si la apertura original está cerrada, el movimiento se imputa a la apertura vigente del mismo terminal. Una devolución de consumo crea `refundReviews` privado para coordinar su rectificativa; no reabre automáticamente la cuenta.
- Cadena fiscal por NIF e instalación entre locales, series y años. Vinculación global privada `fiscalInstallations` para impedir duplicar una instalación entre restaurantes. Emisión, correlativo, índice de número, registro, cabeza y outbox son atómicos. No se modifica ningún original emitido.
- Antes de emitir o remitir se verifica la integridad de la cadena. Un rechazo se conserva; `correctRejectedFiscalRecord` crea subsanación con el mismo número y un registro nuevo, con actor autorizado y motivo. El procesador fiscal serializa por cadena mediante lease, conserva respuestas por intento y reintenta el mismo XML sin nueva venta.
- El arqueo toma el efectivo neto y los movimientos, separando entrega y cambio. Un descuadre exige motivo. El reparto de propinas usa minutos aprobados, descuenta devoluciones vinculadas al cobro original aunque ocurran en otra caja y no admite doble reparto. `payTipDistribution`, servicio interno autenticado sin nueva callable, registra una sola salida `tip_payout` desde una apertura posterior del mismo terminal. No modifica el arqueo cerrado.

## Preparar la fila 3

Usar `XDG_DATA_HOME=/tmp/llenamos-pnpm`, `XDG_CACHE_HOME=/tmp/llenamos-cache`, `XDG_RUNTIME_DIR=/tmp/f3-runtime` y `XDG_CONFIG_HOME=/tmp/f3-config` si el aislamiento impide escribir la configuración personal de las herramientas. Crear antes ese directorio de runtime. No hace falta iniciar sesión en Firebase.

```bash
pnpm install --frozen-lockfile
pnpm funciones:build
mkdir -p .firebase/fase3
pnpm --filter functions exec tsup src/fase3/emulator-entry.ts --out-dir ../.firebase/fase3/lib
```

Crear en `.firebase/fase3/package.json` una copia del de `functions`, con `main: "lib/emulator-entry.js"`, y enlazar `.firebase/fase3/node_modules` a `../../functions/node_modules`. La configuración local, excluida de git, copia `firebase.json`, usa `.firebase/fase3` como source de Functions y estos puertos: Auth 9104, Firestore 8098, Functions 5014, Storage 9214, Hub 4413, Logging 4513, Eventarc 9313 y Tasks 9513. En esta comprobación se deshabilita la UI y se reserva 4013 para el websocket de Firestore, evitando usar puertos de otra fila.

```bash
npx firebase emulators:start --project demo-llenamos --config firebase.agente3.json
```

En otra terminal:

```bash
export GCLOUD_PROJECT=demo-llenamos
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8098
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9104
pnpm seed
pnpm seed:servicio
pnpm exec tsx scripts/seed-fase3.ts
TEST_FIREBASE_EMULATORS=1 pnpm --filter functions test
pnpm exec tsx functions/src/fase3/local.ts demo-lumbre
```

Para una comprobación centrada en esta fila, `TEST_FIREBASE_EMULATORS=1 pnpm --filter functions exec vitest run src/fase3 src/fase2 --hookTimeout=60000`. La integración completa se ha verificado en dos bloques sucesivos sobre emuladores limpios: primero `vitest run src/backend.integration.test.ts src/reservations.integration.test.ts --hookTimeout=60000`; después `vitest run --exclude src/backend.integration.test.ts --exclude src/reservations.integration.test.ts --hookTimeout=60000`, siempre desde `functions` y con las variables de emulador anteriores y `TEST_FIREBASE_EMULATORS=1`. Así las aserciones antiguas que esperan actividad de disparadores se comprueban antes del volumen de eventos de creación y limpieza de las suites de caja/sala. No se omite ninguna prueba habilitada de la fila.

El seed activa `pos`, configura exclusivamente el emisor inventado de prueba y abre el terminal principal con 10000 céntimos. Repetirlo no reinicia numeración, caja, cuentas ni registros fiscales.

Para Chromium, arrancar la web en 3013 con las variables de `.env.example` y los cuatro `NEXT_PUBLIC_*_EMULATOR_PORT` de esta fila; ejecutar `node functions/src/fase3/browser-check.mjs` con las variables anteriores. El script necesita el seed y una apertura principal sin movimientos previos. Usa las cuentas de `/entrar` y comprueba las funciones por HTTP real y el bloqueo/cierre en el comandero. Guarda capturas a 2x y resultados sin credenciales en `docs/diseno/capturas/caja-backend/`. No crea una pantalla de caja paralela.

Parar los emuladores antes de la suite de reglas, porque utiliza los mismos puertos y limpia sus datos:

```bash
npx firebase emulators:exec --project demo-llenamos --config firebase.agente3.json --only firestore,storage "vitest run --root tests/rules"
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Límites de esta entrega local

La publicación de las exportaciones comunes, la pantalla de caja, las callables móviles y las de impresión se integran con sus filas respectivas. El proveedor fiscal definitivo, TicketBAI, anticipos reales, declaraciones del productor, envío a Hacienda y restauración operativa con conservación reglamentaria requieren el proveedor elegido antes de producción. No se ha conectado Stripe real ni una impresora física. El pago físico del reparto y la subsanación técnica se ofrecen como servicios internos autenticados, no añaden firmas al contrato congelado.
