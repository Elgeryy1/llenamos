# Cierre de sala y comandero

Recorrido local del 9 de noviembre de 2026 en `fase2/completar-sala`. Firebase `demo-llenamos`, emuladores de la fila 1 y Next.js en 3011. Capturas reales PNG a 2x, con escritorio de 1440 × 900, tableta de 1180 × 820 y móvil de 390 × 844. Solo se oculta el indicador de desarrollo de Next.

## Resultado por prioridad

| Prioridad | Resultado y prueba |
|---|---|
| 2 y Q11 | Borrador en el navegador por persona, local y sesión; líneas, nota, salida y destino. QR por navegador y enlace de mesa. Se recarga y cambia de vista sin perderlo. Se descarta la respuesta HTTP real después de que el servidor confirme y se recupera tras recargar, con la misma clave y la misma comanda. Integración comprueba concurrencia, recuperación tras mover o cerrar la sesión y rechazo de otra entrada con la misma clave. Se fuerza un cambio de precio y de comensales, conservando las líneas y exigiendo revisión. |
| 4 | El plano muestra llamada, listo, aprobación, cuenta y preparando, con prioridad explícita. La ficha mantiene los estados simultáneos y el tiempo sentados. La prueba produce estados mediante callables reales, sin modificar cocina ni barra. |
| 5 | La recogida enumera cantidades, platos, variantes, extras, notas y comensal. Se coge una tarea y se añade otra bandeja; dueño y plazo se conservan y aparece un aviso. Integración rechaza completar con una lista anterior de platos. Orden: vencidas, propias dentro del grupo y antigüedad. |
| 7 | Un toque añade platos sencillos y suma repetidos. Opciones obligatorias abren formulario; cada línea permite editar opciones, nota y comensal y sumar o restar. Repetir última ronda reconstruye las elecciones y vuelve a calcular con la carta vigente. |
| 12 | Ajuste de horario para mesas abiertas desde Todas las comandas. El servidor lo aplica a personal y QR, con cierres, excepciones, zona horaria y turnos nocturnos. Bandeja de los tres canales, filtros por estado y fecha local y detalle desplegable con destino, notas y platos. |
| 13 | Llamadas con agua, cubiertos, servilletas, quiero pedir u otra petición y nota. Motivos distintos se reúnen en una tarea activa; no pierden dueño ni plazo. |
| Platos de menú | No aparecen como platos sueltos a cero euros los de categorías inactivas, como Solo en el menú del seed. Se conservan en las elecciones de menú. |

## Capturas

| Archivo | Qué enseña |
|---|---|
| [01](01-borrador-escritorio.png) | Borrador recuperado, platos sumados y nota en escritorio |
| [02](02-borrador-tableta.png) | Comandero en tableta |
| [03](03-llamada-qr-movil.png) | Motivo y nota de llamada desde móvil |
| [04](04-sala-llamada.png) | Llamada visible en el plano |
| [05](05-recogida-detalle.png) | Bandeja detallada, extras, notas, variante y nueva entrega |
| [06](06-recogida-movil.png) | Recogida en móvil sin otra pantalla |
| [07](07-sala-listo.png) | Prioridad de listo y ficha con estados simultáneos y minutos |
| [08](08-bandeja-comandas.png) | Bandeja general del local |
| [09](09-politica-horaria.png) | Política horaria guardada desde la interfaz |
| [10](10-qr-recuperado.png) | QR recuperado después de perder la respuesta y recargar |
| [11](11-revision-precio.png) | Cambio de precio que exige revisar el total |
| [12](12-revision-destino.png) | Cambio de comensales con borrador conservado |
| [13](13-comandero-movil.png) | Camarero móvil con borrador propio y sin el borrador del propietario |

El script [scripts/e2e-completar-sala.cjs](../../../../scripts/e2e-completar-sala.cjs) produce las capturas y `resultado.json`. Usa propietario y camarero desde `/entrar`, contraseña de demo `Llenamos2026!`, y un contexto público independiente para QR. Crea comandas y tareas reales en el restaurante de demostración. Para repetir desde cero, reinicia los emuladores y vuelve a cargar los dos seeds.

## Reproducción

Configura `firebase.agente1.json` copiando `firebase.json`: Auth 9102, Firestore 8096, Functions 5012, Storage 9212, UI 4011, Hub 4411, Logging 4511, Eventarc 9311 y Tasks 9511. En `apps/web/.env.local`, copia `.env.example` y fija los cuatro puertos `NEXT_PUBLIC_*_EMULATOR_PORT` correspondientes.

```bash
export PNPM_HOME=/tmp/llenamos-pnpm
export XDG_CONFIG_HOME=/tmp/llenamos-agent1-config
export GCLOUD_PROJECT=demo-llenamos
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8096
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9102
pnpm funciones:build
npx firebase emulators:start --project demo-llenamos --config firebase.agente1.json
# Otras terminales, con las mismas variables:
pnpm seed
pnpm seed:servicio
pnpm --filter web exec next dev --port 3011
node scripts/e2e-completar-sala.cjs
```

El aislamiento de `XDG_CONFIG_HOME` evita reutilizar credenciales de Firebase del equipo. `PNPM_HOME` conserva los temporales en una ruta escribible. El script solo llama a localhost y al proyecto demo. No necesita cuentas nuevas, proveedores externos ni Stripe.

## Cambios de contrato

Detalle normativo en [ARQUITECTURA.md](../../../../ARQUITECTURA.md), apartado Cierre de sala:

1. Entradas opcionales `requestId`, `expectedDestination` y `expectedPrices` en `enviarPedido` y `pedirDesdeMesa`. Respuesta `destination?` en `verMesaPublica`. Colección privada `orderSubmissions` con resultado atómico y sin caducidad en esta fase. La lectura de recuperación accede solo al documento de la clave pedida.
2. Exportaciones puras `orderPriceSignature` y `tableOrderingAllowed`. Comprobación de destino, versiones y precios antes de crear una comanda nueva. Las recuperaciones mantienen la respuesta original.
3. `FloorSettings.allowOrdersOutsideHours?`, ausente o true conserva la política anterior. False exige turno vigente, hasta el final del minuto de última entrada.
4. `avisarDesdeMesa.reason?` y `note` opcional; `FloorTask.requests?` conserva hasta diez parejas distintas de motivo y nota. Repetir conserva dueño y plazo.
5. `cambiarEstadoTarea.expectedLineIds?` y ampliación de `FloorTask.count` cuando una recogida recibe más líneas. El cliente nuevo confirma solo la bandeja que ha visto.
6. Persistencia local del borrador y envío incierto, prioridad del plano, detalle de recogida, repetición de ronda y nueva ruta `/panel/comandas`, con permisos y módulo existentes.

Los campos nuevos son opcionales para poder integrar las ramas paralelas. Los clientes anteriores siguen aceptados; solo los que mandan clave tienen idempotencia. Sin almacenamiento local disponible, se impide comenzar un envío que perdería su clave. El borrador no se sincroniza entre dispositivos y no se añade cola offline.

La pantalla pública solo recibe los cambios mínimos de persistencia, recuperación, revisión de destino y motivos de llamada exigidos por este encargo. No se cambia su catálogo, búsqueda, idiomas, QR administrativo ni para llevar, ni las pantallas de cocina y barra.

## Comprobaciones y decisiones

Retoma tras el reinicio: revisado el commit de trabajo en curso y corregidas dos opciones de consulta incompatibles con los tipos de Testing Library. El recorrido usa ahora la instalación estable de Playwright y el nombre accesible completo de las mesas.

Validación repetida en esta retoma:

- `pnpm install` y `pnpm funciones:build` completados.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` en verde: core 339 pruebas, web 446 y functions 69 sin integración.
- Functions con `TEST_FIREBASE_EMULATORS=1`, proyecto demo y Auth 9102 / Firestore 8096: 108 pruebas aprobadas. Once pruebas de R2 están condicionadas a `TEST_R2_EMULATORS=1` y al puerto 8097, por lo que no se ejecutan en la fila 1. La primera ejecución agotó dos esperas de disparadores de fase 1 durante el arranque; la repetición completa con los emuladores activos pasó sin cambios en esas funciones ni sus pruebas.
- Reglas de Firestore y Storage con el comando `emulators:exec` indicado en el encargo y `firebase.agente1.json`: 78 pruebas aprobadas.
- Navegador real con ambos seeds: trece capturas a 2x y `resultado.json` con cero errores de página. Las respuestas HTTP descartadas se recuperan después de recargar tanto en camarero como en QR, comprobando que no aparece una segunda comanda.
- Web 3011 y emuladores propios detenidos al acabar. Sin cambios temporales de limpieza en el código entregado.

Sin dependencias nuevas, cambios de reglas, índices ni permisos. Dinero entero y precios definitivos del servidor. No se ha hecho commit ni push. Mensaje propuesto: `Completa sala con borradores persistentes y envíos idempotentes`.

La política fuera de horario conserva el permiso previo hasta que el encargado la desactive. El mismo dueño atiende las nuevas entregas de una recogida; si llegan entre verla y confirmarla, el servidor exige revisión. El historial general consulta las colecciones existentes del local, igual que el resto de la fase 2; la paginación de grandes históricos queda fuera de este encargo.
