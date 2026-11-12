# Migración al VPS · reparto de agentes

Encargo del propietario, 2026-11-10: portar todos los módulos al VPS (PostgreSQL + API + worker)
y dejar listo el despliegue, con agentes Sonnet 5.5 en pensamiento medio, como mucho 5 a la vez.
El coordinador revisa y fusiona. Contrato general: `docs/tareas/PLAN-DEPLOY-VPS.md` (léelo entero).

## Reglas para todos

- Rama base e integración: `deploy/vps-production`. Tu rama: `vps/<tu-letra>-<tema>`. Haz push de tu
  rama y **no abras PR**; el coordinador fusiona.
- Commits: `git -c user.name="Elgeryy1" -c user.email="noreply@logiqd.me" commit …`, mensaje en
  castellano, terminado en `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. No cambies la
  config global de git. No reescribas commits subidos.
- Todo en local: PostgreSQL de pruebas con `sh apps/api/scripts/test-postgres-docker.sh` (contenedor
  temporal, puerto aleatorio) y emuladores de Firebase solo para Auth con proyecto `demo-llenamos`.
  Nada en la nube, no gastes dinero, no crees proyectos. No mates procesos que no hayas arrancado.
- Ejecuta las pruebas en primer plano y espera su resultado. No termines el turno con algo en marcha.
- No inventes éxitos: si un proveedor no está configurado, la operación falla con su código.
- Textos de la interfaz en castellano, sin guiones dentro de frase y sin Title Case.
- Antes de cada push: `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` y las pruebas de PostgreSQL
  en verde. Si algo falla y no es tuyo, dilo en tu informe; no lo tapes.

## Contrato común (ya en la rama base, no lo cambies sin decirlo en el informe)

- **Operaciones:** cada módulo vive en `apps/api/src/modules/<modulo>/` y exporta un
  `ModuleDefinition` (`apps/api/src/modules/types.ts`). Se registra con **una línea** en
  `apps/api/src/modules/index.ts`. No edites el registro central `apps/api/src/operations.ts`.
  Los nombres, entradas y salidas son los contratos de `@llenamos/core` que ya usa la web.
- **Transacción y permisos:** el servidor abre `withIdentity` (RLS por restaurante con
  `app.actor_uid` y `app.restaurant_id`), comprueba rol y suscripción y valida la salida antes de
  COMMIT. Tus tablas nuevas llevan `restaurant_id`, RLS `FORCE` con la política `tenant_access`,
  dueño `llenamos_migrator` y solo los GRANT mínimos a `llenamos_app` (mira `001_foundation.sql`).
- **Eventos:** `emitEvent(client, …)` de `apps/api/src/events.ts` dentro de la misma transacción.
  Temas `modulo.entidad` (p. ej. `reservas.reserva`). Sin datos personales en el payload.
- **Avisos y trabajos:** `enqueueOutbox(client, …)` de `apps/api/src/outbox.ts` con ID estable.
  Nunca envíes correos, mensajes ni cobros dentro de la petición HTTP: los hace el worker.
- **Lecturas en vivo:** cada módulo declara `liveQueries` (foto SQL acotada + temas). En la web,
  `useLiveQuery(name, input, schema)` de `apps/web/src/lib/api/live.ts`. La implementa V1; hasta
  entonces responde `not-deployed`, así que en tus pruebas de UI simúlala.
- **Backend en la web:** con `NEXT_PUBLIC_DATA_BACKEND=postgres` no se toca Firestore, Functions ni
  Storage. La demo con emuladores (`firebase-demo`) sigue funcionando como hasta ahora.
- **Consultas acotadas:** nada de leer históricos completos. Filtra por fecha/estado con índice y
  pagina con cursor. Es uno de los fallos de la auditoría Fable.
- **Pruebas:** integración con PostgreSQL de cada operación nueva (`*.integration.test.ts`, se
  saltan sin `TEST_POSTGRES_API=1`), incluido aislamiento entre dos restaurantes y rol sin permiso.
  Las pruebas cargan todas las migraciones con `migrationSql()` de `src/test-migrations.ts`.

## Puertos y migraciones por agente

| Agente | Rama | Migración reservada | Auth emulado | Web | Resto de emuladores (si te hacen falta) |
| --- | --- | --- | --- | --- | --- |
| V1 | `vps/v1-tiempo-real` | `005_*.sql` | 9102 | 3011 | Firestore 8096, Functions 5012, UI 4011, hub 4411, logging 4511 |
| V2 | `vps/v2-worker-archivos` | `006_*.sql` | 9103 | 3012 | Firestore 8097, Functions 5013, UI 4012, hub 4412, logging 4512 |
| V3 | `vps/v3-reservas` | `007_*.sql` | 9104 | 3013 | Firestore 8098, Functions 5014, UI 4013, hub 4413, logging 4513 |
| V4 | `vps/v4-sala-cocina` | `008_*.sql` | 9105 | 3014 | Firestore 8099, Functions 5015, UI 4014, hub 4414, logging 4514 |
| V5 | `vps/v5-caja` | `009_*.sql` | 9106 | 3015 | Firestore 8100, Functions 5016, UI 4015, hub 4415, logging 4515 |

Si necesitas una segunda migración, usa el mismo número con sufijo de letra (`007b_*.sql`). En el PC
Compute ya están ocupados 3003, 3389, 6379, 8080, 9090, 80/443, 22, 53, 111, 1194 y 2049.

## Tanda 1

### V1 · Tiempo real, cliente de datos y sincronización
- API: endpoint de suscripción SSE autenticado con `Authorization` (fetch, nunca token en query),
  que resuelve las `liveQueries` de `MODULES`, manda la foto inicial y refresca al llegar eventos de
  sus temas (LISTEN/NOTIFY o sondeo por cursor `id`), con `Last-Event-ID`, latido, límite de
  conexiones por identidad y cierre al revocar la sesión.
- Web: implementa `useLiveQuery` (reconexión con espera creciente, cancelación al cambiar de cuenta).
  Separa `lib/firebase/client.ts` en cliente solo Auth y transporte de datos de demo. Lleva al VPS
  `lib/data/{callables,functions}.ts`, `components/panel/PanelData.tsx`, `lib/config/hooks.ts` y
  ajustes generales (`app/(personal)/panel/ajustes`).
- Sincronización sin conexión: porta `functions/src/fase6-sync` y `lib/sin-conexion/cliente.ts`
  (cola IndexedDB/Web Locks, streams, versiones, recibos y reconciliación) a SQL, como servicio que
  usarán sala y cocina. Documenta su contrato en `apps/api/src/modules/sync/README.md`.

### V2 · Worker, avisos, archivos, privacidad y copias
- Worker aparte (`apps/worker` o entrada propia en `apps/api`) que reclama `outbox` y `jobs` con
  lease, reintentos limitados, cuarentena e ID estable del proveedor. Porta `functions/src/messages`,
  `providers`, `webhooks` (firma WhatsApp) y el envío de correo. Receptor genérico de webhooks con
  firma (Stripe, WhatsApp) e idempotencia por ID de evento; los módulos registran su manejador.
- Archivos privados en volumen fuera de la raíz pública: subida y descarga autorizadas, límites de
  tamaño y tipo, sustituye `lib/firebase/storage.ts`. Fotos de la carta las usa V4.
- Privacidad (`fase6-privacy`: exportación y borrado) y copias (`fase6-backup`): copia cifrada de SQL
  y archivos fuera del VPS, más un script de restauración aislada probado en Docker.
- Infra: `compose.worker` y volúmenes en `deploy/vps`, con límites de memoria del plan.

### V3 · Reservas completas
- Porta `functions/src/reservations.ts`, `reservationTriggers.ts`, `waitlist`, `deposit` (señal con
  Stripe vía el receptor de V2) y la parte de reservas de `fase5/reservation-integration.ts`.
- Web: `lib/data/{reservas,clientes,hooks}.ts`, `lib/plano/guardar.ts` (sin escrituras directas:
  comandos explícitos), páginas públicas de reserva, gestión por enlace y widget.
- Sin sobreventa con concurrencia, tokens privados, consultas por estado y fecha.
- **Antiabuso (Fable):** límites por IP verificada, restaurante y destinatario antes de encolar
  avisos, validación de credenciales antes de cargar contexto, campo trampa. Prueba duplicados,
  token falso y abuso con carga.

### V4 · Carta, QR, sala, cocina, barra y recogida
- Porta `functions/src/fase2` (carta, sesiones de mesa, pedidos, comandas, tareas, recogida, push).
- Web: `lib/carta/*` (fotos con los archivos de V2), `lib/comandero/*`, `lib/cocina/*`,
  `components/comandero/GestionMesa.tsx`, `components/cocina/EstacionView.tsx`, `components/avisos/*`.
- Endpoints públicos de mesa y recogida de `FASE2_ACCESS` con límites antiabuso.
- Online por la API; la cola sin conexión la conecta con el servicio de V1 cuando esté (si no llega a
  tiempo, déjalo documentado y la UI en modo solo online en VPS, como ahora).

### V5 · Caja, fiscal, cobros e impresión
- Porta `functions/src/fase3`, `fase3-mobile` y `fase3-print` (cuentas, cobros, devoluciones, cierre,
  fiscal, tickets, cola de impresión, cobro con Stripe vía V2).
- Web: `lib/caja/*` y `lib/impresion/*`.
- Sin doble cobro, doble sello ni doble impresión: idempotencia y outbox. Fiscal (Verifactu) sigue
  sin proveedor decidido: sin adaptador real, falla con su código; no simules el envío.

## Tanda 2 (cuando acabe la tanda 1)

- Personal, inventario, costes y compras (`fase4`).
- Fidelización, campañas, análisis y Repite (`fase5`).
- Plataforma restante: facturación (`fase6-billing`) y API pública con eventos (`fase6-api`).
- Limpieza: ningún import productivo de `firebase/firestore`, `firebase/functions` ni
  `firebase/storage`; claves de proveedores bien conectadas (Fable).
- Ensayo de despliegue completo en Docker del PC Compute como si fuera el VPS: compose entero,
  migraciones, copia y restauración, prueba de carga con histórico y recorrido con cada rol.

## Informe final de cada agente

Rama y último commit, qué funciona ya en modo VPS (con las pruebas que lo demuestran), qué queda
fuera y por qué, y cambios que hayas tenido que hacer en el contrato común.
