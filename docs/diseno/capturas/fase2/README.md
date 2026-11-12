# Fase 2 · Prueba de punta a punta

Recorrido real del 9 de noviembre de 2026, en `fase2/integracion`, contra Next.js y los emuladores de Firebase de **demo-llenamos**. No se han usado servicios de nube ni Stripe. Se retoma el commit `fff45d2` («prueba de punta a punta en curso»). Las capturas 01 a 05 vienen de ese commit; las siguientes completan y verifican el recorrido.

Todas son capturas del navegador con `deviceScaleFactor: 2`: escritorio 1440 × 900 (PNG 2880 × 1800), tableta 1180 × 820 (2360 × 1640), móvil táctil 390 × 844 (780 × 1688). Se oculta únicamente el indicador de desarrollo de Next. Se mantiene el diseño de sala cálida.

## Preparación y cuentas

Fila 1: Auth 9102, Firestore 8096, Functions 5012, Storage 9212, UI 4011, Hub 4411, Logging 4511, Eventarc 9311, Tasks 9511 y web 3011. Se usa `firebase.agente1.json`, copiado de `firebase.json` con esos puertos y excluido de git.

```bash
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8096
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9102
pnpm funciones:build
npx firebase emulators:start --project demo-llenamos --config firebase.agente1.json
# En otra terminal, con las mismas variables:
pnpm seed
pnpm seed:servicio
pnpm --filter web exec next dev --port 3011
```

La web tiene los cuatro `NEXT_PUBLIC_*_EMULATOR_PORT` de la fila 1 en `apps/web/.env.local`. En este entorno restringido se ha usado además `PNPM_HOME=/tmp/llenamos-agente1-pnpm` y `XDG_CONFIG_HOME=/tmp/f2-a1-config` para mantener los archivos temporales dentro de las rutas permitidas y aislar la configuración de Firebase.

Entrar en `/entrar`. Contraseña común: `Llenamos2026!`.

| Trabajo | Cuenta |
|---|---|
| Carta, ajustes y aprobación | `encargada@lumbre.test` |
| Servicio móvil y tareas | `camarero@lumbre.test` |
| Cocina y postres en tableta | `cocina@lumbre.test` |
| Barra en tableta | `barra@lumbre.test` |
| Planes en `/logiqd` | `equipo@logiqd.test` |
| Cliente QR y para llevar | Sin sesión, contexto independiente |

## Recorrido y evidencias

### 1. Encargada: carta y configuración

El agente anterior creó «Arroz de integración», con variante, extra y alérgenos, subió una imagen PNG de prueba a Storage y marcó el plato agotado. También configuró estaciones y generó un QR. Se han revisado sus cambios y capturas; se conservan como evidencia del comienzo del recorrido.

| Captura | Paso |
|---|---|
| [01 · Foto](01-carta-foto.png) | Foto subida y leída desde Storage en el editor del plato |
| [02 · Agotado](02-carta-agotado.png) | Plato marcado agotado en la carta |
| [03 · Estaciones](03-configuracion-estaciones.png) | Configuración de cocina, barra y postres |
| [04 · QR](04-qr-mesa.png) | Generación del enlace de mesa y etiqueta NFC |

La continuación arranca con `seed` y `seed:servicio`, que dejan 43 reservas de hoy. Se conserva la aprobación de pedidos de mesa. Para probar el menú durante la tarde se amplió temporalmente su fin de 16:00 a 23:59 desde el editor. La prueba antigua del seed lo restableció a 16:00 durante la ejecución; se corrigió su aislamiento antes de repetir las pruebas.

### 2. Camarero móvil: reserva, mesa y pedido

Bernat Riera se sienta en S1 desde Reservas. La operación abre la sesión de mesa y la asocia a su reserva y cliente. En Comandero se elige esa sesión y se pide una ración de croquetas, hamburguesa con cheddar, menú con sopa, pollo y crema catalana, y agua. Total confirmado por el servidor: **4350 céntimos**. Se envía reteniendo la comida y se marchan los primeros; el agua marcha directamente a barra.

| Captura | Paso |
|---|---|
| [05 · Reserva móvil](05-reserva-movil.png) | Inicio del recorrido heredado |
| [06 · Sentada](06-reserva-sentada.png) | Bernat sentado en S1 |
| [07 · Variante](07-comandero-variante.png) | Ración de croquetas |
| [08 · Extra](08-comandero-extra.png) | Cheddar en la hamburguesa |
| [09 · Menú](09-comandero-menu.png) | Selecciones del menú del día |
| [10 · Envío](10-pedido-enviado.png) | Pedido confirmado y platos retenidos |

### 3. Cocina, barra y recogida

Cocina recibe croquetas y sopa en primeros, con hamburguesa y pollo retenidos en segundos. Barra recibe exclusivamente el agua. Se empieza cada plato, se marca listo y aparece la tarea de recogida agrupada por estación. Diego pulsa «Voy yo» y «Recogido y servido». Después marcha segundos y postres, se preparan y se sirven también.

| Captura | Paso |
|---|---|
| [11 · Primeros](11-cocina-primeros.png) | Ticket por estación y pase |
| [12 · Barra](12-barra-solo-bebidas.png) | Solo bebida, sin platos de cocina |
| [13 · Preparando](13-cocina-preparando.png) | Inicio de preparación |
| [14 · Listos](14-cocina-primeros-listos.png) | Primeros listos para recoger |
| [15 · Dueño](15-recogida-con-dueno.png) | Tarea asumida por Diego («Vas tú») |
| [16 · Segundos](16-cocina-segundos.png) | Segundo pase marchado |

### 4. Cliente QR en catalán y tareas con dueño

Se abre S2 como otra sesión y se genera su QR desde los ajustes. Un navegador móvil sin sesión entra por ese enlace, cambia a catalán y pide patatas bravas. El pedido se guarda con idioma `ca`, estado pendiente y **650 céntimos** calculados en el servidor. La encargada lo acepta por ese mismo importe. El cliente llama al camarero y pide la cuenta; Diego asume ambas tareas. Repetir la cuenta agrupa los avisos y conserva al dueño.

| Captura | Paso |
|---|---|
| [17 · QR de S2](17-qr-cliente.png) | Enlace real generado para la segunda mesa |
| [18 · Pedido en catalán](18-qr-pedido-catalan.png) | Revisión del total del carrito |
| [19 · Pendiente](19-qr-pendiente.png) | Envío confirmado, a la espera del personal |
| [20 · Aprobación](20-encargada-aprueba.png) | Encargada acepta el pedido |
| [21 · Llamada](21-llamada-con-dueno.png) | Camarero con tarea asignada |
| [22 · Cuenta](22-cuenta-con-dueno.png) | Tarea de cuenta asignada y agrupación de avisos |
| [43 · Título corregido](43-carta-catalan-titulo.png) | La página QR identifica la carta, sin ofrecer una reserva |

Las pruebas de integración verifican además precios manipulados, variantes, extras, suplementos y tokens de otra mesa o local. `expectedTotalCents` solo detecta cambios; nunca fija el precio.

### 5. Mover, juntar, separar y cerrar

El intento de mover S1 a S3 se rechaza porque S3 sigue ocupada. Se cancelan las reservas de demostración de Lucía en S9 y Raúl en S2, con motivo de prueba, para disponer de destinos compatibles. S1 se mueve a S9 y vuelve a S1. Se junta con la sesión abierta de S2 tras reconocer la atribución del consumo al cliente de S1. Total conjunto: **5000 céntimos**.

Se separa S2 con las bravas: la nueva sesión conserva el cliente, 650 céntimos y dos comensales; la original queda con 4350 céntimos. Tras servir sus platos, se cierran las dos sesiones. La reserva de Bernat queda `finished`, su ficha muestra una visita y **50 € de consumo registrado**. La primera sesión cerrada aportaba 43,50 €; la segunda añade 6,50 €. No se registra ningún pago. La auditoría final de Firestore confirma dos sesiones cerradas y la sesión absorbida en `merged`, con total cero.

| Captura | Paso |
|---|---|
| [29 · Movimiento](29-mesa-movida.png) | Sesión en S9 |
| [30 · Unión](30-mesas-juntadas.png) | Sesión S1+S2, cuatro personas |
| [31 · Separación](31-mesas-separadas.png) | S1 y S2 vuelven a tener sesiones distintas |
| [32 · Cierre](32-mesa-cerrada.png) | S1 cerrada y botón de reapertura |
| [33 · Primer consumo](33-cliente-consumo.png) | Primera aportación de 43,50 € |
| [41 · Reserva terminada](41-reserva-terminada.png) | Reserva finalizada desde el cierre de mesa |
| [42 · Consumo conjunto](42-cliente-consumo-tras-separar.png) | 50 € tras cerrar ambas sesiones |

### 6. Para llevar: web, cocina y recogida

El seed cierra los lunes. Se elige el martes 10 a las 13:00 para la recogida pública, con nombre, teléfono y consentimiento, y una ración de bravas por **650 céntimos**. El servidor confirma la hora y devuelve el enlace privado de seguimiento. La encargada acepta y adelanta la preparación con «Marchar todo» para completar la prueba sin esperar al día siguiente. Cocina empieza y marca listo; la encargada entrega al cliente. El móvil muestra «Recogido» y su ficha recibe 6,50 € de consumo, sin inventar una visita de reserva.

| Captura | Paso |
|---|---|
| [34 · Carrito público](34-para-llevar-publico.png) | Contacto, consentimiento y total |
| [35 · Confirmación](35-para-llevar-confirmado.png) | Referencia y enlace de seguimiento |
| [36 · Seguimiento pendiente](36-para-llevar-seguimiento.png) | Hora confirmada y espera de aprobación |
| [37 · Cocina](37-para-llevar-cocina.png) | Ticket de recogida marchado |
| [38 · Listo](38-para-llevar-listo.png) | Preparación terminada |
| [39 · Entrega](39-para-llevar-entregado.png) | Entrega confirmada por el servidor |
| [40 · Recogido](40-para-llevar-recogido.png) | Seguimiento público final |
| [44 · Consumo](44-consumo-para-llevar.png) | Consumo de la recogida en la ficha |

El procesador programado no corre automáticamente en los emuladores. La integración prueba `processTakeaways`; para probar su ejecución manual local existe `GCLOUD_PROJECT=demo-llenamos pnpm sala:procesar demo-lumbre centro`, con el host de Firestore de la fila 1.

### 7. Roles y plan

Se cambia el plan a `reservas` con el equipo LogiQD. Se comprueban el menú, Inicio y las direcciones directas. Sala, comandero, carta, para llevar, configuración del servicio, cocina y barra quedan fuera del plan. Reservas conserva su propio plano de asignación y el editor de Plano, que forman parte de reservas. Se restaura `sala` al terminar. El camarero no accede a Carta ni a los ajustes de sala; cocina no accede al comandero.

| Captura | Paso |
|---|---|
| [23 · Plan](23-logiqd-plan-reservas.png) | Cambio con equipo LogiQD |
| [24 · Comandero bloqueado](24-plan-sin-sala.png) | Sin módulo de sala |
| [25 · Cocina bloqueada](25-plan-sin-cocina.png) | Sin módulos de servicio |
| [26 · Camarero y carta](26-camarero-sin-carta.png) | Acceso directo denegado por rol |
| [27 · Camarero y ajustes](27-camarero-sin-configuracion.png) | Acceso directo denegado por rol |
| [28 · Cocina y comandero](28-cocina-sin-comandero.png) | Acceso directo denegado por rol |
| [45 · Inicio de Reservas](45-inicio-plan-reservas.png) | Sin enlace ni resumen de sala |
| [46 · Sala bloqueada](46-sala-bloqueada-por-plan.png) | La ruta antigua tampoco elude el módulo |
| [47 · Inicio de cocina](47-inicio-cocina.png) | Acceso a la estación ya disponible con plan Sala |

## Arreglos y decisiones

El commit de partida corrigió el bloqueo entre guardar una foto y publicar la carta, permitió `updatedBy: null` en cartas y menús creados por servidor y mostró el consumo en la ficha. Esos cambios de core ya estaban documentados en el contrato y se mantienen.

Esta continuación añade:

- Aislamiento de la prueba del seed en un restaurante temporal. Antes reescribía `demo-lumbre`, cambiando módulos y carta mientras se probaba el navegador. El seed normal conserva su destino por defecto.
- Un evento atrasado de una reserva borrada ya no falla al intentar generar mensajes. Tiene una regresión contra Firestore real.
- Títulos de Carta y Para llevar correctos en la web pública, manteniendo idiomas y diseño.
- Bloqueo de Sala por `floor` en menú, Inicio y ruta directa. El plan Reservas no abre la sala antigua. Se precisa este comportamiento en `ARQUITECTURA.md`, sin cambiar core ni firmas de callables.
- Inicio de cocina y barra con acceso a su estación real, sustituyendo el texto antiguo que anunciaba que llegaría en fase 2. Respeta los módulos activos.

No hay dependencias nuevas. No se han cambiado reglas, precios, transiciones de core ni firmas públicas. Las acciones se confirman esperando la respuesta del servidor; intentar cerrar mientras aún se está sirviendo puede rechazarse y exige esperar a la confirmación del servido.

## Comprobaciones

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build

TEST_FIREBASE_EMULATORS=1 GCLOUD_PROJECT=demo-llenamos \
FIRESTORE_EMULATOR_HOST=127.0.0.1:8096 \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9102 \
pnpm --filter functions exec vitest run src/fase2

# Parar antes los emuladores del recorrido. Esta suite borra los datos locales.
npx firebase emulators:exec --project demo-llenamos \
  --config firebase.agente1.json --only firestore,storage \
  "vitest run --root tests/rules"
```

Resultados: comprobación general en verde, 845 pruebas unitarias (337 core, 439 web y 69 functions), 27 de integración de fase 2 y 78 de reglas de Firestore y Storage. Las integraciones que necesitan otros indicadores de entorno quedan omitidas en el comando unitario normal. No se han ejecutado suites contra servicios reales.

Los procesos iniciados para esta prueba se detienen al acabar mediante `kill` a sus PID. No se hace commit ni push. Mensaje de commit propuesto: **«Completar la prueba de punta a punta de sala y cocina y corregir accesos por plan»**.
