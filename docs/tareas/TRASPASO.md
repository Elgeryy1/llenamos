# Traspaso · estado de Llenamos al apagar (9 de noviembre de 2026, noche)

Documento para retomar el trabajo en una sesión nueva, porque el chat del coordinador se pierde. Leer junto con [`PROMPT-MAESTRO.md`](PROMPT-MAESTRO.md) (cómo coordinar), [`../ESTADO.md`](../ESTADO.md) (qué trae cada fase y cómo va), [`../../PLAN.md`](../../PLAN.md) (fases, decisiones y registro) y [`../../ARQUITECTURA.md`](../../ARQUITECTURA.md) (contrato).


> **Actualización 10 de noviembre (tarde):** **todas las fases (0 a 6) están hechas, integradas y fusionadas en `main`**, probadas de punta a punta en local. No hay agentes en marcha. Lo que queda no es construir fases sino: decisiones del propietario (apartado 4 y las de la fase 5 en `ESTADO.md`), producción (proyecto real de Firebase, secretos, Stripe, Verifactu homologado, WhatsApp verificado, procesos programados), pruebas con material real (impresora, cajón, push) y Repite (PR en borrador LogiQD/repite#1 con SQLite y la API v1). README con capturas nuevas: se rehacen con `scripts/readme-imagenes.ts` (emuladores en los puertos de `firebase.json`, web en 3000 con `NEXT_PUBLIC_EMULATOR_HOST=127.0.0.1`, seeds de todas las fases y `scripts/fase5-trabajadores.ts analisis`). Pendientes técnicos anotados: la copia exige una ventana sin escrituras, la regla de listado de facturas restringidas por privacidad no está cerrada, `platformEvents` sin caducidad, `collectionGroup('versions')` en Billing lee también las versiones de recetas y `scripts/fase3-e2e.mjs` está desfasado.

## 1. Qué está hecho y en `main`

| Fase | Estado | Notas |
|---|---|---|
| 0 · Cimientos | ✅ | |
| 1 · Reservas | ✅ | Lista de espera con oferta, señal (probada con pagos simulados), `.xlsx`, Dependabot |
| Etapa 0 · Diseño | ✅ | B «Sala cálida» + vista por horas de A + vista partida de C, aplicado a todo; controles propios (desplegable, fecha, hora); capturas reales en `apps/landing` |
| 2 · Sala y cocina | ✅ | Probada de punta a punta (`docs/diseno/capturas/fase2/`) y rematada frente a RestaurantOS (`comparativa-restaurantos.md`). Falta probar avisos push en un móvil real |
| 3 · Caja | ✅ | Backend, pantalla `/panel/caja`, impresión ESC/POS con puente local (`tools/print-bridge`), pago móvil y recibo, prueba de punta a punta (`docs/diseno/capturas/fase3/`). Verifactu con proveedor de prueba «no válido para Hacienda». Falta impresora y cajón reales y Stripe real |
| 4 · Personal, inventario y costes | 🔨 | **Contrato en main.** Backend casi terminado en la rama `fase4/backend` (ver 2) |
| 6 · Plataforma | 🔨 | **En main:** contrato, sin conexión (integrado), alta y Billing, panel LogiQD y API (estos dos **sin integrar**, ver 3). Copias y RGPD a medias en su rama |
| 5 · Clientes y análisis | ⏳ | Sin empezar. Decidido: Repite se conecta con el servicio existente |

`main` está en verde: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, reglas (Firestore y Storage) e integración de functions (`src/fase2 src/fase3 src/fase3-print src/fase3-mobile src/fase6-sync`).

## 2. Ramas con trabajo sin fusionar

| Rama | Estado | Qué falta |
|---|---|---|
| `fase4/backend` | Casi terminado (Sonnet, parado al apagar): callables, reglas e índices con pruebas, seed idempotente, prueba de punta a punta, carrera de fichajes | Pasar las comprobaciones completas, revisar y fusionar. Exportar sus funciones en `functions/src/index.ts` si no lo hizo |
| `fase6/copias-rgpd` | A medias (ya trae `main` fusionado y adaptado; último commit «Trabajo en curso») | Terminar copias con simulacro de restauración y RGPD (exportar, borrar o anonimizar conservando facturas y fichajes, caducidad). Su script de capturas usaba un `heading` donde hay un `div` |
| `fase1/pendientes` (worktree `agente2-pendientes`) | Ya fusionada en main | Nada. El worktree local está desfasado: se puede borrar |

Todas las ramas de los agentes están subidas a GitHub. Los worktrees están en `/srv/LogiQD/llenamos/.claude/worktrees/` (excluidos de git); se pueden recrear con `git worktree add`.

## 3. Lo que queda para terminar

### Fase 4
1. Revisar y fusionar `fase4/backend`.
2. En paralelo, las pantallas según la tabla de reparto de `fase-4-reparto.md`: fichaje y cuadrante; inventario y escandallos; proveedores y pedidos (más el menú: entradas en `apps/web/src/lib/panel/nav.ts`, icono en `components/panel/sidebar/app-sidebar.tsx` y pruebas en `nav.test.ts`).
3. Prueba de punta a punta con capturas y cierre (ESTADO, PLAN).

### Fase 6
1. Terminar `fase6/copias-rgpd`.
2. **Integración de la fase 6** (pendientes que dejaron los agentes, detallados en sus README y `reglas.md`):
   - Exportar en `functions/src/index.ts` las funciones de `fase6-billing` (diez, ver su `emulator-entry.ts`, incluida `cambiarExcepcionesPlataforma`), `fase6-api` (`listarRestaurantesLogiqd`, `verUsoPlataforma`, `abrirAccesoSoporte`, `listarIntegraciones`, `crearClaveApi`, `revocarClaveApi`, `guardarWebhook`, `rotarSecretoWebhook`, `repetirEntregaWebhook`, `plataformaApi`) y las de privacidad y copias.
   - Reglas e índices: los de `functions/src/fase6-billing/reglas.md`, `functions/src/fase6-api/reglas.md` (incluye quitar la excepción antigua de lectura con el claim `logiqd` en `restaurants/{rid}`) y los de copias y RGPD.
   - Conectar `assertPlatformCapacity` y `refreshPlatformAccess` (alta y Billing) en los escritores compartidos, para que la suspensión por impago y los límites del plan se apliquen a todo.
   - Conectar `enqueuePlatformEvent(tx, event)` en la misma transacción en reservas, sala (`Context.flush`), caja (pago confirmado), Billing y privacidad: hoy no sale ningún webhook real.
   - Menú: «Plan y facturación» (`/panel/planes`, `planes.ver`), «Integraciones» (`/panel/integraciones`, `integraciones.gestionar`), «Privacidad» y el acceso a `/logiqd` para el claim `logiqd`; enlace público a `/alta`.
   - Prueba de punta a punta: alta de un restaurante nuevo, prueba gratis, cambio de plan, impago que suspende, API con clave, webhook recibido, exportar y borrar un cliente, simulacro de restauración.
3. Para producción (no en local): secreto `PLATFORM_API_MASTER_KEY` (32 bytes hex), disparadores programados para medir el uso y para el worker de webhooks.

### Fase 5 (sin empezar)
Contrato primero (`docs/tareas/fase-5-reparto.md` por escribir, como los de las fases 3, 4 y 6), luego agentes: Repite conectado con el servicio existente (`LogiQD/repite`; antes hay que pasar Repite de su JSON de pilotos a una base de datos), puntos y promociones, campañas con permiso, origen de las reservas, panel de ventas y comparativa entre locales, resumen diario, previsión y automatizaciones que recomiendan. Fila «5» del apartado 24 de `comparativa-restaurantos.md`.

### Lanzamiento (solo cuando lo diga el propietario)
Apartado «Lanzamiento» de `PLAN.md`. En logiqd.me ya está `/llenamos` con «próximamente» (ver memoria `web-logiqd-despliegue`).

## 4. Decisiones pendientes del propietario

| Decisión | Bloquea | Recomendación |
|---|---|---|
| Proveedor de Verifactu (por API o directo con la AEAT) | Vender la caja | Proveedor homologado por API |
| Quién cobra la señal y el pago móvil (Stripe de cada restaurante o de LogiQD) | Cobros reales | Stripe Connect, cada restaurante con su cuenta |
| Planes: cuadrar Barra, Sala y Grupo con los módulos (incluidos `staff` e `inventory`), precios y límites | Vender y Billing | Barra = reservas; Sala = reservas + sala y cocina; Grupo = todo con varios locales |
| En qué plan entra Repite | Fase 5 | Módulo opcional aparte |
| Fase 4: pausas, momento de descontar stock, vender sin existencias, conservación de fichajes | Vender personal e inventario | Descontar pausas, descontar al marchar, permitir con aviso, 4 años |
| Fase 2: gasto al juntar mesas de clientes distintos; recogida con los horarios de reservas | Vender sala | Lo fijado en el contrato |
| Cuenta de WhatsApp Business verificada; datos legales; cuándo lanzar | Envíos reales y lanzamiento | |

## 5. Cómo se ha trabajado (para retomar igual)

- **Coordinador** en Claude Code (Opus) sobre `/srv/LogiQD/llenamos`; **agentes** en worktrees, uno por rama. Máximo 5 a la vez, con la fila de puertos de `etapa-0-reparto.md`.
- **Codex** (`gpt-6.1-sol`, esfuerzo alto) para ahorrar cuota de Claude: `docs/tareas/encargos/lanzar.sh <encargo> <worktree>` con su caja `workspace-write`. Su caja deja git en solo lectura: el coordinador hace el commit y el push. **La cuota semanal de Codex vuelve el 16 de noviembre a las 18:30.**
- **Sonnet** (agentes de Claude) cuando Codex no tiene cuota: sí pueden hacer commit y push (`normas-claude.txt`).
- Encargos y normas usados están en [`encargos/`](encargos/). Al retomar una rama a medias, añadir que revise el último commit «Trabajo en curso».
- Al fusionar: `git merge --no-ff --no-commit`, resolver, `pnpm funciones:build`, comprobaciones completas (reglas con `firebase.agente0.json`: Firestore 8110, Auth 9120, Storage 9220, excluido de git) e integración de functions con emuladores recién arrancados.
- Si hay muchos conflictos, fusionar `origin/main` en la rama del agente y que el agente los resuelva.
- Las tareas en segundo plano de la sesión duran como mucho 2 horas: los emuladores y la web de prueba para el propietario se paran solos. Para probar desde casa: emuladores con `firebase.agente-red.json` (todas las interfaces), `NEXT_PUBLIC_EMULATOR_HOST=192.168.1.220` en `apps/web/.env.local` y `LLENAMOS_DEV_ORIGINS=192.168.1.220 pnpm web`.
- Antes de una tanda larga: `sudo pc-keepawake 6h`; al acabar, `off`.
