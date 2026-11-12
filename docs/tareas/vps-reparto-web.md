# Tanda 3 · la web en modo VPS de punta a punta

Objetivo: que `apps/web` con `NEXT_PUBLIC_DATA_BACKEND=postgres` funcione entera contra la API de `apps/api`: lecturas por `useLiveQuery` (`lib/api/live.ts`), escrituras por `invokeOperation` (`lib/api/operations.ts`), archivos por `lib/api/files.ts`, y Firebase **solo** para el login. Después se despliega en el VPS (`llenamos.logiqd.me` y `app-llenamos.logiqd.me`).

Lee antes: CLAUDE.md, ARQUITECTURA.md, apps/web/AGENTS.md, `apps/web/src/lib/api/README.md` y `OPERATIONS.md`, `docs/tareas/PLAN-DEPLOY-VPS.md`, `DECISIONES.md` y los README de los módulos de `apps/api/src/modules` que uses.

## Reglas comunes
- La demo con emuladores (`firebase-demo`, proyecto `demo-*`) se conserva, pero el código de Firestore, Functions o Storage solo puede cargarse con `import()` dinámico dentro de la rama demo. El bundle de producción (`NEXT_PUBLIC_DATA_BACKEND=postgres`) no debe contener `firebase/firestore`, `firebase/functions` ni `firebase/storage` (W5 lo comprueba).
- Nada de «not-deployed» en una pantalla que se ofrece en VPS. Si una operación o lectura no existe en la API, impleméntala en el módulo de la API que corresponda, con prueba de integración en PostgreSQL. Si de verdad no cabe, oculta la función en VPS con un texto claro y déjalo en tu informe.
- Sin escrituras directas: todo cambio pasa por una operación de la API.
- Textos de interfaz en castellano, sin guiones dentro de las frases y sin Title Case.
- Pruebas: `pnpm -r --workspace-concurrency=1 typecheck`, `lint` y `test`, `sh apps/api/scripts/test-postgres-docker.sh`, y pruebas de los ganchos en modo VPS (como `lib/caja/datos.vps.test.tsx`). El PC va justo de memoria: comprobaciones de una en una.
- Migraciones nuevas solo con tu número. No edites migraciones fusionadas.
- Commits pequeños, push de tu rama y sin PR. Informe final en `/srv/LogiQD/vps/informes/Wn.md`, con este formato: qué funciona en VPS con su prueba, qué queda fuera y por qué, y qué has cambiado del contrato común.

## Reparto

| Agente | Rama | Migración | Puertos (web, Auth) | Terreno |
|---|---|---|---|---|
| W1 | vps/w1-reservas-web | 018 | 3021, 9121 | `lib/data/*` (reservas, clientes, hooks), `lib/plano/guardar.ts`, `components/panel/PanelData.tsx`, `lib/config/hooks.ts`, `lib/publica/*`, páginas públicas de reserva y gestión. Configuración del restaurante: claves de sus proveedores (Stripe, WhatsApp, correo, fiscal, Repite) que guarda el propio restaurante en la bóveda cifrada |
| W2 | vps/w2-sala-web | 019 | 3022, 9122 | `lib/comandero/*`, `components/comandero/*` (incluido sentar una reserva desde `GestionMesa`, que hoy está oculto en VPS), `lib/cocina/*`, `lib/carta/*` (con las fotos por `lib/api/files.ts`), avisos y QR o recogida públicos |
| W3 | vps/w3-caja-web | 020 | 3023, 9123 | `lib/caja/*`, `lib/impresion/*` y la API de caja. Además: la sesión de Checkout de la señal de reserva y los cobros móviles de caja (`crearEnlaceCobro`, `verCobroPublico`, `iniciarPagoCuenta`, `confirmExternalPayment`, recibo digital), siempre con la clave de Stripe **del restaurante** guardada en su bóveda; la parte pública solo abre la credencial de ese restaurante para esa operación |
| W4 | vps/w4-gestion-web | 021 | 3024, 9124 | `lib/personal/*`, `lib/inventario/*`, `lib/compras/*`, `lib/analisis/*`, `lib/campanas/*` y `lib/fidelizacion/*`. Además: privacidad de los fichajes (ver DECISIONES.md, 2026-11-12) |
| W5 | vps/w5-plataforma-web | 022 | 3025, 9125 | `lib/firebase/*` (separar `client.ts` en solo Auth y demo; `live.ts`, `storage.ts` y `demo-data.ts` solo para demo), comprobación del bundle de producción (prueba que construye con `postgres` y falla si aparece Firestore, Functions o Storage), login y recuperación con Firebase Auth real, alta de restaurantes por LogiQD y aceptación de invitaciones en la web, y la imagen web de `deploy/vps` con la configuración pública de Auth del proyecto `llenamos-logiqd` |

Si necesitas tocar el terreno de otro, hazlo mínimo y apúntalo en tu informe.
