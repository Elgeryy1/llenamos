# Alta y Billing · fila 2 del reparto, agente de puertos 4

`/alta` prepara acceso, datos, local, plano sencillo, horarios, carta opcional, oferta y revisión. Crea en una transacción restaurante, propietario, índice de usuario y slug, local, zona, mesas, estación, ajustes, prueba y actividad. El slug comprueba también restaurantes antiguos. El índice privado por uid impide repetir la prueba incluso con otro borrador. El mismo requestId recupera una respuesta perdida; otra huella con ese id se rechaza. No se crean restaurantes parcialmente visibles.

Los platos opcionales quedan internos, con precios enteros, alérgenos sin revisar y pedido público apagado. Se revisan desde Carta antes de publicarse. El motor y las funciones existentes sirven reservas y comandas sobre el restaurante creado. El navegador conserva el borrador por uid y las peticiones pendientes de alta y Billing; una recarga permite reintentar la misma operación.

`/panel/planes` muestra prueba, fechas, módulos, catálogo provisional, periodicidad, acceso al portal y baja. Solo owner gestiona, owner y manager consultan. La suspensión conserva la administración y los datos. Los restaurantes antiguos no se migran en silencio. `crearRestaurante` comparte el servicio de alta y `cambiarPlan` rechaza los migrados antes de escribir.

## Contrato y dependencias

Sin dependencias nuevas. Cambio mínimo y aditivo de core: `OnboardingDraft.floor?` (`areaName,tableCount,seats`) y `menu?` (`{name,priceCents}[]`), documentado en ARQUITECTURA.md. No cambia ninguna firma existente. Sin plano se crean seis mesas de cuatro plazas. El asistente configura duraciones de 90 minutos sin tramos especiales; se pueden ajustar después.

Propuesta provisional: Barra 4900 céntimos/mes o 46800/año; Sala 9900/94800; Grupo 19900/190800, sin IVA. Repite fuera de las ofertas nuevas. El catálogo se lee en servidor desde versiones inmutables y completa la propuesta inicial hasta publicarse un catálogo; el navegador no aporta precios ni ids Price. Una nueva oferta puede tener otros módulos y límites. Antes de vender deben aprobarse catálogo, límites, términos y mecanismo de identidad y abuso de pruebas entre cuentas distintas. No se promete que crear otra identidad no permita otra prueba.

## Stripe Billing

Webhook independiente `stripeBillingWebhook`. Firma HMAC sobre `rawBody`, tolerancia de cinco minutos, incluyendo fechas futuras. Usa secreto separado. Deduplica transaccionalmente el id del evento y escribe cambio, acceso, actividad y evento de plataforma en la misma transacción. Checkout solo vincula ids contra una intención guardada; su retorno no activa nada. Factura pagada exige ids de cliente y suscripción guardados, un Price único del catálogo, EUR, importe exacto de servidor, una línea, una unidad y periodo vigente. Las facturas con descuentos, prorrateos, impuestos añadidos o varias líneas quedan rechazadas para revisión; no se concede acceso por importes que no se hayan validado.

Eventos antiguos o empatados en fecha consultan el contrato y la factura vigente mediante el puerto del proveedor, fuera de transacción. Si no se puede consultar, devuelve 503 y no modifica acceso. La carrera con otro evento obliga a reintentar la reconciliación. Los impagos no renuevan los siete días de gracia por cada evento. Una baja final no revive con facturas ni actualizaciones tardías. Un cambio de portal pagado con exceso de cuota suspende acceso para revisión y conserva todos los recursos.

Configuración futura: `STRIPE_BILLING_SECRET_KEY`, `STRIPE_BILLING_WEBHOOK_SECRET`, `STRIPE_BILLING_RETURN_ORIGIN` HTTPS e ids Price versionados en servidor. Retornos y claves idempotentes se fijan en servidor. API del adaptador fijada a `2025-06-30.basil`. El adaptador HTTP está **siempre desactivado en emuladores y proyectos demo**, aunque reciba claves. Sin configuración devuelve literalmente «La facturación de la suscripción no está configurada. No se ha realizado ningún cargo». La prueba local permanece como prueba y nunca se convierte en un pago ficticio.

Las pruebas sustituyen HTTP e inyectan respuestas del proveedor. Las cargas de ejemplo están en `fixtures.ts`; el webhook HTTP real del emulador usa únicamente `whsec_solo_fixtures_locales`. No se ha accedido a Stripe real ni se ha realizado ningún cargo. Documentación de referencia: [Checkout](https://docs.stripe.com/api/checkout/sessions/create), [eventos](https://docs.stripe.com/api/events/object), [verificación de firmas y recuperación](https://docs.stripe.com/events/manage-webhook-endpoints).

## Reproducción local

Todos los comandos se ejecutan desde este worktree. Si pnpm intenta instalarse fuera del sandbox, usar `XDG_DATA_HOME=/tmp/llenamos-agente4-data`. Para Firebase, `XDG_CONFIG_HOME=/tmp/llenamos-agente4-config` evita usar la sesión real de la máquina. No hace falta iniciar sesión en Firebase.

```sh
pnpm install
pnpm funciones:build
pnpm exec tsx scripts/billing-local-build.ts
STRIPE_BILLING_WEBHOOK_SECRET=whsec_solo_fixtures_locales npx firebase emulators:start --project demo-llenamos --config firebase.agente4.json
```

El preparador genera únicamente `firebase.agente4.json`, `.env.local` de web y la entrada empaquetada ignorada de Functions. Copia los puertos de agente 4. No modifica `firebase.json`, `functions/src/index.ts` ni configuración compartida. Volver a arrancar los emuladores si se recompila la entrada local: los workers existentes pueden conservar el bundle anterior.

En otra terminal, con `GCLOUD_PROJECT=demo-llenamos`, `FIRESTORE_EMULATOR_HOST=127.0.0.1:8099` y `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9105`:

```sh
pnpm seed
pnpm seed:servicio
TEST_FIREBASE_EMULATORS=1 pnpm --filter functions exec vitest run src/fase6-billing/backend.integration.test.ts
pnpm exec tsx scripts/billing-procesar.ts
pnpm --filter web exec next dev --port 3014
```

Con la web en marcha: `pnpm exec tsx scripts/billing-navegador.ts`. Entra primero con la cuenta demo de /entrar y contraseña Llenamos2026!, después crea un acceso ficticio únicamente en Auth local para el alta. Comprueba recarga, pérdida de respuesta posterior al commit y recuperación del mismo restaurante, prueba y Billing sin claves. Capturas a 2x en `docs/diseno/capturas/alta-billing/`. También puede usarse `next start --port 3014` después del build para capturas sin el indicador de desarrollo.

Al terminar, parar solo los procesos de esta fila. No ejecutar la suite de reglas mientras se usa el navegador o se mide la integración: sus suites limpian Firestore.

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
npx firebase emulators:exec --project demo-llenamos --config firebase.agente4.json --only firestore,storage "vitest run --root tests/rules"
```

## Trabajador y contadores

`billing-procesar.ts` restringe proyecto y hosts de fila 4 y llama exactamente a `processSubscriptions`. Recorre restaurantes en páginas y transacciones independientes, sin red. La salud privada `platformWorkers/billing` distingue ausencia (nunca ejecutado), running, completed con fecha y evaluated, y failed con fecha y error saneado. No corre solo en los emuladores. `verSuscripcion` también reevalúa acceso; los escritores sensibles deben consultar la fecha antes de autorizar, además del worker y las reglas.

Servicios para el coordinador, exportados desde `index.ts`:

```ts
const capacity = await assertPlatformCapacity(tx, restaurantId, 'members', additional, now)
// Terminar aquí todas las lecturas de la operación.
capacity.commit()
// Escribir la operación autorizada dentro de esta misma transacción.
```

Cada servicio devuelve un commit diferido: Firestore exige todas las lecturas antes de las escrituras. **Si se llama a ambos, ejecutar solo capacity.commit()**, que ya incluye el refresco; no duplicar el commit ni reservar dos veces el mismo recurso. Agrupar additional por recurso. Para operaciones sin alta basta refresh. Los antiguos devuelven null y conservan compatibilidad. Los contadores de `platform/usage` son autoritativos; la proyección de métricas no sirve para reservar cuota. Desactivar o eliminar debe decrementar el contador en la misma transacción, sin negativos. Falta de contador o exceso bloquean nuevas altas.

## Integración reservada al coordinador

- Añadir en `functions/src/index.ts` las diez funciones que exporta `emulator-entry.ts` de esta carpeta. La entrada local ya permite probarlas.
- Aplicar [reglas.md](reglas.md) e índice de grupo de colección. Las pruebas de esta fila verifican el fragmento restrictivo, no reglas comunes que todavía no se han integrado.
- Conectar `assertPlatformCapacity` en invitación y reactivación de miembros y en el escritor de creación de locales. El reparto reserva esos puntos compartidos al coordinador; no se han editado sus carpetas. En claves y webhooks el agente de API usa el mismo servicio. Reconciliar contadores al migrar; este encargo no migra restaurantes antiguos.
- Conectar `refreshPlatformAccess` antes de autorizar escrituras sensibles en contextos de reservas, fase 2 y caja. Llamar commit después de las demás lecturas, dentro de la operación. Comprobar el acceso también en páginas públicas del backend; las proyecciones públicas no autorizan operaciones.
- Navegación como datos: grupo Restaurante, etiqueta «Plan y facturación», href `/panel/planes`, permiso `planes.ver`, sin módulo operativo. Enlace público `/alta` desde el acceso o la web de venta. No se ha tocado `lib/panel/nav.ts`, layouts comunes ni landing.
- `audit` deja un evento `subscription.changed` determinista y sin contactos en `platformEvents`; el agente de API debe conectar su distribución. No se promete entrega externa hasta integrar su worker.

Hasta conectar reglas y escritores compartidos, **la suspensión y las cuotas no están aplicadas a todas las operaciones preexistentes del sistema**. Los servicios y sus carreras están probados, pero esa integración es condición para cerrar la fase. No se debe desplegar autoservicio público antes de completar esos puntos y la revisión comercial.

## Inventario para privacidad y copias

`onboardings.draft` puede contener nombre, dirección, ciudad, teléfono y texto de carta. `users` y `members` contienen identidad de personal, no clientes. `platformRequests` guarda actor, huella y respuesta idempotente (en alta, ids y estado; en Billing, URL efímera del proveedor). `onboardingKeys` mantiene uid, restaurante y prueba usada como barrera restringida; no debe eliminarse para conceder otra prueba. `billingIntents` tiene ids de proveedor, estado y resultado con URL de Checkout/portal; no contiene claves de Stripe. `billingEvents` solo ids, estado, restaurante y fecha; no conserva la factura ni contactos del proveedor. `platformEvents` y actividad no repiten datos de contacto. Copias deben incluir versiones de catálogo usadas, índice de slug, barreras y contadores, manteniendo bloqueados los emisores tras restauración. Credenciales van fuera de la copia.

## Comprobaciones de la entrega

- Lint, tipos, pruebas y build del monorepo ejecutados en verde. Suite general: 423 pruebas de core, 480 de web y 81 de Functions; las integraciones requieren habilitación explícita y no cuentan como ejecutadas en ese comando.
- Integración propia con Auth, Firestore y Functions reales de la fila 4: 15 pruebas. Incluye creación operativa, concurrencia, cuotas, vencimiento, baja, impago, reconciliación, ausencia de claves y endpoint firmado. Repetida también con emuladores recién arrancados.
- `emulators:exec --only firestore,storage`: cuatro archivos, 95 pruebas en verde. Incluye el fragmento de reglas todavía pendiente de integrar por el coordinador.
- Chromium: alta, recarga del plano, carta interna, recuperación tras respuesta perdida y pantalla de planes sin claves. Capturas de escritorio y móvil a 2x; cero errores de página.
- Una repetición intermedia de la suite general agotó los cinco segundos de una prueba existente de descompresión XLSX bajo carga. No se ha modificado esa prueba ni su límite. La carga futura de la prueba HTTP de Billing usa diez minutos de separación, para que el arranque del emulador no consuma un margen de solo un segundo sobre la tolerancia de cinco minutos del servidor.

Los emuladores de esta fila han quedado parados. El lanzador de web ha terminado, pero queda un listener sin respuesta en 3014 que el sandbox no permite asociar a un PID del host. El coordinador debe localizar ese listener desde el host, comprobar que corresponde a este worktree y terminar únicamente ese proceso. No se han detenido procesos de otras filas.

Mensaje de commit propuesto: `feat(plataforma): alta guiada y facturación de suscripciones`. Sin commit ni push en este worktree.
