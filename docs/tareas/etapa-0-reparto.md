# Etapa 0 · Diseño elegido y cierre de la fase 1 · reparto entre agentes

Objetivo: el panel entero, la web pública y el widget con el diseño elegido, capturas reales en la web de venta y los pendientes de la fase 1 cerrados. Al acabar, se enseña y se vende tal cual.

**Diseño decidido por el usuario (2026-11-09):** B «Sala cálida» (`diseno/propuesta-b`) como base, con dos piezas de las otras propuestas:

- de **A** (`diseno/propuesta-a`): la **vista por horas** de Reservas (una fila por mesa, horas en horizontal, línea de «ahora», llegadas por media hora arriba) como segunda vista con conmutador lista / tiempo, y la **paleta Ctrl K / ⌘K** con sus atajos si encaja sin chocar;
- de **C** (`diseno/propuesta-c`): la **vista partida** lista + plano en la misma pantalla para tableta (tocar una reserva marca su mesa y al revés, botones de 48 px), en el tema oscuro cálido de B. El tema claro de C **no** entra.

Cada propuesta tiene su README y capturas en `docs/diseno/propuestas/<x>/` dentro de su rama (`git show origin/diseno/propuesta-b:docs/diseno/propuestas/b/README.md`).

## Orden

1. **Tanda 1** (en paralelo, cada uno en su worktree):
   - **D · Diseño final** (`diseno/final`, agente 1): fusiona B y trae las piezas de A y C. Es la base de la tanda 2.
   - **P · Pendientes de la fase 1** (`fase1/pendientes`, agente 2): lista de espera, señal, `.xlsx` y Dependabot. Sin tocar el aspecto.
   - **K · Contrato de la fase 2** (`fase2/contrato`, agente 3): adelanta la etapa 1 en `packages/core` y `ARQUITECTURA.md`. No toca la web.
2. **Tanda 2** (cuando D esté en `main`): aplicar el sistema al resto, por zonas (Z1 a Z4, abajo).
3. **Coordinador**: capturas reales para la web de venta (`apps/landing/src/captures.ts` y `public/capturas/`) con `pnpm seed:servicio`, y cierre de la etapa en `PLAN.md`.

## Puertos

Los del coordinador (9099, 8085, 5001, 9199, UI 4001, web 3000) **no se tocan**. Cada agente crea en la raíz de su worktree `firebase.agente<N>.json` (ya excluido en `.git/info/exclude`) copiando `firebase.json` con sus puertos, y arranca con `npx firebase emulators:start --project demo-llenamos --config firebase.agente<N>.json` (sin `--import`). Su web: `pnpm --filter web exec next dev --port <web>` con `apps/web/.env.local` copiado de `.env.example` y los `NEXT_PUBLIC_*_EMULATOR_PORT` suyos. Seed y pruebas: `FIRESTORE_EMULATOR_HOST=127.0.0.1:<firestore>` y `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:<auth>`.

| Agente | Auth | Firestore | Functions | Storage | UI | Hub | Logging | Eventarc | Tasks | Web |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 9102 | 8096 | 5012 | 9212 | 4011 | 4411 | 4511 | 9311 | 9511 | 3011 |
| 2 | 9103 | 8097 | 5013 | 9213 | 4012 | 4412 | 4512 | 9312 | 9512 | 3012 |
| 3 | 9104 | 8098 | 5014 | 9214 | 4013 | 4413 | 4513 | 9313 | 9513 | 3013 |
| 4 | 9105 | 8099 | 5015 | 9215 | 4014 | 4414 | 4514 | 9314 | 9514 | 3014 |
| 5 | 9106 | 8100 | 5016 | 9216 | 4015 | 4415 | 4515 | 9315 | 9515 | 3015 |

Puertos prohibidos (otros servicios del PC): 3003, 3389, 6379, 8080, 9090, 80, 443. Nadie mata procesos que no haya arrancado; al acabar, cada agente para sus emuladores y su web.

## Reglas comunes

- Leer antes `CLAUDE.md`, `ARQUITECTURA.md`, `PLAN.md`, este archivo, `docs/diseno/README.md` y `docs/diseno/componentes.md`. Quien toque `apps/web`, también `apps/web/AGENTS.md` y las guías de `apps/web/node_modules/next/dist/docs/` que apliquen (Next 16.4).
- En el worktree: `pnpm install` y `pnpm funciones:build` antes de nada.
- TypeScript estricto. Textos de interfaz en castellano llano, **sin guiones dentro de las frases y sin mayúsculas en cada palabra**. Comentarios en castellano. Finales de línea LF.
- Sin dependencias nuevas salvo las que diga el encargo.
- Dinero en céntimos enteros. Precios en el servidor. Cada escritura de cliente en Firestore lleva `updatedBy`.
- Todo en local con los emuladores (`demo-llenamos`). Sin claves no se envía nada y la interfaz lo dice; nada simulado como si fuera real.
- Commits en castellano con `git -c user.name=Elgeryy1 -c user.email=noreply@logiqd.me commit …`, terminados en `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nunca `--amend` sobre algo subido. Push de la rama (`git push -u origin <rama>`), **sin PR**.
- Antes de entregar: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` en verde, y las pruebas de reglas con tu config (`npx firebase emulators:exec --project demo-llenamos --config firebase.agente<N>.json --only firestore "vitest run --root tests/rules"`) si tocas reglas o funciones.
- Quien toque pantallas: capturas reales a 2x con Playwright (ya instalado: `require('playwright')`, `chromium.launch()`) contra su web y sus emuladores, con `pnpm seed` y `pnpm seed:servicio`, en escritorio (1440×900), tableta (1180×820) cuando aplique y móvil (390×844). Se guardan en `docs/diseno/capturas/<zona>/`.
- Informe final corto: qué se ha hecho, cómo probarlo, comprobaciones, dependencias nuevas, supuestos, pendiente y SHA.

---

## D · Diseño final · `diseno/final` · agente 1

Carpetas: `apps/web/` (marco del panel, reservas, sala, `components/{common,panel,reservas,sala,ui}`, `globals.css`) y `docs/diseno/`.

1. Rama nueva desde `main`; fusiona `origin/diseno/propuesta-b` con `--no-ff`.
2. **Reservas, dos vistas** con conmutador lista / tiempo (se recuerda la elegida por persona en el navegador): la lista de B y la línea de tiempo de A (`components/reservas/Timeline.tsx` y su prueba), restilada con las capas, radios y colores de B. Pulsar un bloque abre el detalle de siempre.
3. **Paleta Ctrl K / ⌘K** de A (`components/panel/command/*`, `ui/command.tsx`, dependencia `cmdk`, permitida) con sus atajos, si no chocan con nada de B. Atajos sueltos desactivados mientras se escribe o hay una ventana abierta; `?` enseña la lista. Con el aspecto de B.
4. **Vista partida para tableta** de C: en Reservas, a partir del ancho de tableta, la lista a la izquierda y el plano de B (`components/sala/Plano.tsx`) a la derecha. Tocar una reserva resalta su mesa y cambia a su zona; tocar una mesa elige su reserva y la trae a la vista. Barra de la reserva elegida con botones de 48 px (sentar, cambiar mesa, cancelar, no presentado, «llegó tarde: sentar»). Puede usar `ui/resizable.tsx` de C (dependencia `react-resizable-panels`, permitida). En móvil, lista sola con un conmutador lista / plano.
5. Arreglar los pendientes de B: el texto que roza el borde en las mesas redondas pequeñas del plano, y los selectores de día y turno que se parten en dos líneas en el móvil (390 px).
6. No tocar la lógica (`functions/`, `packages/core/`, reglas, `apps/web/src/lib/**` salvo lo puramente de presentación) ni las acciones (`actionsFor`, `runStatusAction`).
7. Actualizar `docs/diseno/README.md` (fundamentos y reglas del sistema nuevo: capas, sombras suaves, tamaños, ancho, color, icono y palabra en el plano) y `docs/diseno/componentes.md` (piezas nuevas, origen y licencia). Este documento es lo que seguirán los agentes de la tanda 2, así que tiene que bastar para aplicar el sistema a otra pantalla sin mirar el código de B. Añade las piezas nuevas a `/panel/muestra`.
8. Capturas en `docs/diseno/capturas/final/`: reservas lista, reservas tiempo, paleta abierta, sala, tableta con vista partida y una reserva elegida, móvil.

Comprobación: la común, más pruebas de Vitest de la línea de tiempo, la vista partida (seleccionar reserva → mesa y al revés) y los atajos.

---

## P · Pendientes de la fase 1 · `fase1/pendientes` · agente 2

Carpetas: `functions/`, `packages/core/`, `tests/`, `scripts/`, y en `apps/web/` solo la lógica de importar (`lib/`) y lo mínimo de las páginas públicas de la lista de espera y la señal. **No cambies el aspecto** de ninguna pantalla: lo rehace la tanda 2.

1. **Aceptar una oferta de la lista de espera**, de punta a punta: cancelar una reserva → se ofrece la franja a la primera entrada compatible → el mensaje capturado lleva el enlace → abrir el enlace en `/r/[slug]` → aceptar (`aceptarOfertaListaEspera`) crea la reserva, y caduca bien pasado `waitlist.offerMinutes`. Prueba de integración contra emuladores y prueba con Playwright del enlace. Arregla lo que no funcione.
2. **Señal**: sin clave de Stripe no hay pago real. Deja probado con el emulador y cargas firmadas de ejemplo (HMAC sin SDK) el flujo completo: reserva `pending` con `deposit.status: "required"` cuando hay `STRIPE_SECRET_KEY` de mentira en la prueba, `iniciarPagoSenal` contra un `fetch` simulado en la prueba, `stripeWebhook` con firma buena, mala, repetida y caducada, `checkout.session.completed` → pagada y confirmada. Sin clave: `not_configured` y la web lo dice. Apunta en `ARQUITECTURA.md` que no se ha probado contra Stripe real.
3. **Leer `.xlsx` al importar**: sin dependencia pesada. Preferible sin ninguna: un `.xlsx` es un zip; se puede leer con `DecompressionStream("deflate-raw")` del navegador y el XML de `sharedStrings` y la primera hoja. Si no cabe, `fflate` está permitida (pequeña, MIT). SheetJS no. Fechas y horas de Excel (números de serie) bien convertidas. Pruebas con un `.xlsx` de ejemplo en `tests/fixtures/` generado por código.
4. **Alertas de Dependabot**: `gh api repos/LogiQD/llenamos/dependabot/alerts --jq '.[] | select(.state=="open") | {number, package: .dependency.package.name, severity: .security_advisory.severity, fixed: .security_vulnerability.first_patched_version.identifier}'`. Resuélvelas subiendo versiones o con `pnpm.overrides` sin romper nada; las que no tengan arreglo, explícalas en el informe.
5. Actualiza `ARQUITECTURA.md` si cambia el contrato.

Comprobación: la común, más integración de funciones contra tus emuladores.

---

## K · Contrato de la fase 2 · `fase2/contrato` · agente 3

Carpetas: `packages/core/src/` y `ARQUITECTURA.md` (sección nueva «Fase 2 · Sala y cocina»). No toques `apps/`, `functions/` ni reglas.

Fase 2 (de `PLAN.md`): carta digital (categorías, platos, variantes, extras, alérgenos, fotos en Storage, agotados, menú del día, castellano, catalán e inglés); comandero del camarero; pedido desde la mesa por QR (o NFC), llamar al camarero y pedir la cuenta; pantallas de cocina y barra por estación con tiempos y pases (primeros, segundos, postres); tareas de sala con dueño («voy yo») y avisos solo cuando algo se retrasa; mover y juntar mesas; sentar una reserva abre la mesa y une el gasto al cliente; para llevar con hora de recogida. Módulos `floor` y `kitchen`. Precios recalculados en el servidor, dinero en céntimos.

1. **Contrato en `ARQUITECTURA.md`**, como la sección «Fase 1»: datos en Firestore (en inglés) con quién escribe cada campo, tabla de callables (entrada, salida, quién, módulo), disparadores, reglas de acceso por rol y módulo, permisos nuevos en la tabla de roles, estados y transiciones (pedido, línea de pedido, mesa abierta, tarea de sala), y qué no se hace. Piensa en: carta con versiones de precio (una línea guarda el precio con el que se pidió), alérgenos de la lista oficial de la UE (14), textos en `{ es, ca, en }`, estaciones (cocina, barra, postres…) y a qué estación va cada plato, pases y «marchar», sesión de mesa (`tableSessions`) que une reserva, cliente, comensales y pedidos, juntar y mover mesas, pedido desde la mesa con un token de mesa que no deje pedir en otra, y para llevar.
2. **Esquemas zod y tipos** en core (`carta/`, `sala/`, `cocina/` o como mejor quede), adaptadores si hacen falta.
3. **Lógica pura con pruebas**: cálculo del precio de una línea y de un pedido en céntimos (variantes, extras, cantidades, menú del día), validación de un pedido contra la carta (agotados, extras permitidos, variantes obligatorias), transiciones de estados, reparto de líneas por estación y pase, retrasos (cuándo una tarea o una comanda «se está cayendo» según tiempos objetivo), juntar y separar mesas.
4. **Permisos** en `roles.ts` y **entradas y salidas** de las callables en `api.ts`, con pruebas. Plantilla de i18n de los textos de la carta.

Comprobación: `pnpm --filter @llenamos/core typecheck && pnpm --filter @llenamos/core lint && pnpm --filter @llenamos/core test`.

---

## Tanda 2 · aplicar el sistema por zonas (tras fusionar D)

Cada zona desde `main` al día, con `docs/diseno/README.md` y `componentes.md` del sistema nuevo como guía. Sin tocar la lógica. Capturas de cada pantalla en `docs/diseno/capturas/<zona>/`.

- **Z1 · Panel general** (`diseno/z1-panel`, agente 1): inicio, ajustes, equipo, actividad, mensajes, `/logiqd`, `/entrar`.
- **Z2 · Configuración** (`diseno/z2-config`, agente 4): plano (editor), horarios, compartir.
- **Z3 · Clientes** (`diseno/z3-clientes`, agente 5): clientes, lista de espera, importar.
- **Z4 · Pública** (`diseno/z4-publica`, agente 2 cuando acabe P): `/r/[slug]`, gestionar reserva, lista de espera, señal, `/widget/[slug]` y `widget.js`. Móvil primero, 48 px, con la marca del restaurante.
