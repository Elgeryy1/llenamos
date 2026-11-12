# Fase 0 · reparto entre agentes

Los tres parten de `main` (commit `c4a17b3` o posterior), cada uno en su propia rama y su propia copia de trabajo. Todos leen antes `ARQUITECTURA.md`, que es el contrato. Ninguno toca las carpetas de los otros salvo lo indicado. Las dependencias ya están instaladas: no añadir más salvo necesidad, y decirlo en el informe.

Al terminar, cada agente deja su rama con commits limpios y un informe con lo hecho, cómo probarlo y lo que queda pendiente.

---

## A · Backend de Firebase (Codex GPT‑6.1 Sol, nivel alto) · rama `fase0/backend`

Carpetas: `firebase/`, `functions/`, `tests/rules/`, `scripts/`, `.github/workflows/`.

1. **Reglas de Firestore** (`firebase/firestore.rules`) exactamente como la tabla de `ARQUITECTURA.md`: miembros activos, acceso por local (`locationIds` vacío = todos), escritura de owner y manager con validación de campos y tipos, y todo lo demás cerrado.
2. **Pruebas de reglas** en `tests/rules/` (Vitest + `@firebase/rules-unit-testing`), que se ejecutan con `pnpm test:reglas`. Cubrir cada fila de la tabla, a favor y en contra: persona sin sesión, miembro inactivo, miembro de otro restaurante, cada rol, campos no permitidos y tipos erróneos.
3. **Funciones** en `functions/src/`, una por archivo, región `europe-west1`, entradas validadas con zod y permisos con `@llenamos/core`: `crearRestaurante`, `invitarMiembro`, `cambiarRolMiembro`, `desactivarMiembro`, y los disparadores que escriben en `activity`. Escribir siempre `users/{uid}.restaurants` al cambiar una membresía. Errores `HttpsError` con mensaje en castellano.
4. **Pruebas de las funciones** (lógica de permisos y casos límite: no quedarse sin owner, no cambiarse a sí mismo, roles asignables).
5. **Seed** `scripts/seed.ts` (idempotente) con el restaurante de demostración descrito en `ARQUITECTURA.md`, contra los emuladores (`FIRESTORE_EMULATOR_HOST=127.0.0.1:8085`, `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`).
6. **CI** `.github/workflows/ci.yml`: pnpm, Node 22, Java 21, `pnpm verificar`.

Comprobación final: `pnpm --filter functions typecheck && pnpm --filter functions test && pnpm funciones:build && pnpm test:reglas`, y el seed funcionando contra los emuladores.

---

## B · Panel del personal (Opus 5.5, nivel alto) · rama `fase0/panel`

Carpeta: `apps/web/` (sin tocar `functions/` ni `firebase/`).

Antes de nada, leer `apps/web/AGENTS.md` y las guías de `node_modules/next/dist/docs/` que apliquen (Next.js 16.4).

1. **Sistema de diseño** con los colores, tipografía, iconos y curva de animación de `ARQUITECTURA.md`: botón, campo, tarjeta, insignia, estado vacío, esqueleto de carga, aviso de error. Estados completos (hover, activo, foco visible, cargando, vacío, error).
2. **Firebase en el navegador**: inicialización única, conexión a los emuladores cuando `NEXT_PUBLIC_USE_EMULATORS=1`, `getFunctions(app, "europe-west1")`.
3. **Acceso** (`/entrar`): correo y contraseña; en local, lista de las cuentas de demostración para entrar con un clic.
4. **Panel** (`/panel/...`): protegido, con selector de restaurante si hay varios (de `users/{uid}.restaurants`) y navegación según el rol (`can()` de `@llenamos/core`). Páginas:
   - **Inicio**: resumen sencillo del local.
   - **Sala**: plano en directo (`onSnapshot`) por zonas, con las mesas en su posición `x, y, w, h`, forma y plazas. Solo lectura en esta fase.
   - **Equipo** (owner y manager): lista de miembros, invitar, cambiar rol y desactivar con las funciones del contrato.
   - **Actividad** (owner y manager): registro en directo.
   - **Ajustes** (owner y manager): nombre, color de marca e idioma del restaurante.
5. **Pruebas** con Vitest para la lógica y componentes clave.

Mientras el backend no esté, trabajar contra los emuladores con datos creados a mano o con un seed provisional propio que no se suba. Comprobación final: `pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web test && pnpm --filter web build`.

---

## C · Motor de reservas (Opus 5.5, nivel alto) · rama `fase1/motor-reservas`

Carpeta: `packages/core/src/reservas/` (y exportarlo desde `packages/core/src/index.ts`). Sin Firebase: lógica pura y pruebas. Es la base de la fase 1.

1. **Modelo**: horarios del local por día de la semana con varios turnos (comida, cena), días cerrados y excepciones por fecha; duración de la reserva según el tamaño del grupo; margen entre reservas; capacidad máxima de comensales por franja.
2. **Disponibilidad**: dado un día, un tamaño de grupo, las mesas (con `seats`, `joinableWith`, `enabled`) y las reservas existentes, devolver las horas disponibles en saltos de 15 minutos, con zona horaria `Europe/Madrid` (cuidado con los cambios de hora).
3. **Asignación de mesa**: proponer la mejor mesa o combinación de mesas unibles para un grupo, minimizando plazas desperdiciadas, sin solapes, y explicando por qué (para que el encargado decida).
4. **Estados de una reserva** y transiciones permitidas: pendiente, confirmada, sentada, terminada, cancelada, no presentada.
5. **Pruebas exhaustivas** con Vitest, incluidos los días de cambio de hora, grupos que no caben, mesas deshabilitadas y combinaciones.

Comprobación final: `pnpm --filter @llenamos/core typecheck && pnpm --filter @llenamos/core test`.

---

## Integración (agente principal)

Revisar cada rama, fusionar en `main` en este orden: C, A, B. Después arrancar todo en local, cargar el seed, probar el panel con cada cuenta y dejar el registro en `PLAN.md`.
