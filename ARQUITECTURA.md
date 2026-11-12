# Arquitectura y contrato de Llenamos

## Destino definitivo: VPS con Firebase solo para identidad (2026-11-10)

Esta decisión sustituye el destino híbrido: Firebase se conserva solo para cuentas y login.
Datos del restaurante, archivos, servidor, trabajos, webhooks, tiempo real y copias irán al VPS.
El código actual aún usa Firestore/Storage/Functions y debe migrarse: las colecciones y contratos
descritos debajo documentan el sistema de origen, no el destino ya implementado.

Destino: PostgreSQL dedicado, API Node/TypeScript, trabajador con colas durables PostgreSQL y
archivos privados en volumen con copia cifrada externa. No compartir la base de LogiQD HQ.
Firebase Auth mantiene UID/contraseñas/login/recuperación. La API verifica tokens y resuelve
membresías, roles, módulos y revocación operativa en PostgreSQL por petición. No aceptar tokens
solo decodificados ni contraseñas elegidas por quien invita. Mantener aislamiento LogiQD.

Reemplazar SDK de datos por API; reglas Firebase por autorización y políticas SQL; disparadores
por outbox transaccional y worker. Conservar contratos, idempotencia, offline y tiempo real con
pruebas de paridad. No ejecutar emuladores como backend productivo ni fingir compatibilidad SQL.

Plan vigente: `docs/tareas/PLAN-DEPLOY-VPS.md`. Proyecto `llenamos-logiqd` reservado para Auth;
Firestore recién creado queda sin datos reales y sin uso productivo. No se borra automáticamente.
No activar Blaze para Cloud Functions/Storage: esas piezas se sustituyen por servicios del VPS.

Primera entrega de migración: `apps/api` verifica JWT Firebase y sesiones vigentes en PostgreSQL;
las filas operativas están protegidas con RLS y el rol HTTP no tiene privilegios ni propiedad de
tablas. Sesión, contexto del panel y listado administrativo paginado ya usan SQL. El frontend
productivo selecciona `NEXT_PUBLIC_DATA_BACKEND=postgres` y solo inicializa Firebase Auth;
adaptadores todavía sin portar fallan cerrados. No están migrados alta/aceptación, dominios,
archivos, procesos ni tiempo real. No se ha publicado una versión parcial como producto completo.

## Separación de administración acordada el 2026-11-10

Actualización del alta: las APIs de proveedores son opcionales por restaurante. Campos vacíos
permiten el alta y dejan el servicio sin configurar; en edición conservan valores guardados,
salvo retirada explícita. Las credenciales se custodian cifradas por restaurante y solo se
devuelven estados, nunca secretos. No se toman claves globales de otro negocio como alternativa.
Sin correo de plataforma, la invitación queda pendiente y nunca se anuncia como enviada.

Las claves se guardan en `restaurants/{rid}/integrationSecrets/providers`, cifradas con
`PLATFORM_API_MASTER_KEY` y contexto del documento. `providerStatus` es derivado de servidor;
ambas colecciones se excluyen de copias de contenido para no restaurar secretos ni anunciar
configuraciones que ya no existen. Los clientes no pueden leerlas directamente. Los consumidores
de correo, WhatsApp y Stripe resuelven el restaurante antes de obtener claves; en producción no
heredan credenciales de variables globales. Webhooks de esos proveedores requieren
`?restaurantId=<rid>` y verifican firma y correspondencia con el restaurante del evento.
Fiscal y Repite quedan `adapter_pending` aunque se guarde una API, hasta tener un conector real.
Las invitaciones de plataforma solo usan Resend cuando `PLATFORM_EMAIL_ENABLED=1`; habilitarlo
requiere enlazar el secreto real y volver a desplegar, sin secretos ficticios de relleno.

El lanzamiento incluirá todo Llenamos y la presentación con acceso para LogiQD, propietarios y
trabajadores. LogiQD da de alta restaurantes, invita al propietario y configura plan, módulos y
ajustes de plataforma; no accede al interior ni a los datos operativos del restaurante. El
propietario gestiona su restaurante y equipo; cada trabajador solo sus tareas autorizadas.
Elegir una entrada de login no otorga permisos. No habrá impersonación ni soporte con acceso
al interior. Revisar reglas, callables, API, copias/privacidad e IAM para aplicar esta separación,
incluidas rutas actuales con claim `logiqd`. Detalle y aceptación en
`docs/tareas/PLAN-DEPLOY-VPS.md`; decisión en `DECISIONES.md`. Este apartado es el objetivo nuevo,
no una certificación de despliegue productivo. La implementación local añade:

- `platformRestaurants/{rid}` como registro mínimo de administración, sin lecturas del panel
  LogiQD a colecciones operativas. Nuevas callables: `altaRestauranteLogiqd`,
  `listarRestaurantesAdministracion` y `configurarRestauranteLogiqd` (contratos en core).
- Alta administrativa con propietario invitado por correo, idempotencia y enlace de acción
  cifrado bajo `PLATFORM_API_MASTER_KEY`. Para enviar la invitación requiere dominio/remitente
  reales y correo de plataforma habilitado; sin ellos permite el alta con invitación pendiente.
  No entrega contraseñas ni enlaces al operador. No añade a LogiQD como miembro del restaurante.
- `uidOf` deniega cuentas con claim `logiqd` salvo operaciones administrativas opt-in. Las reglas
  de Firestore/Storage también deniegan su acceso operativo aunque tengan membresía por error.
- Sin alta pública productiva, impersonación o soporte interno. El propietario consulta su plan;
  sus cambios los tramita LogiQD. Restaurantes existentes necesitan una migración revisada del
  registro administrativo; no importar la demo ni dar acceso al interior para crear ese registro.
- Custodia de privacidad habilitada explícitamente con proyecto/bucket/clave reales. Las copias
  de contenido quedan para el propietario, no LogiQD. La captura productiva del trabajador de
  copias sigue bloqueada hasta implementar una barrera completa de escrituras; requiere protección
  gestionada y restauración probada mientras tanto. `platformEvents.expiresAt` requiere activar
  TTL en Firestore; el campo solo se fija tras distribuir el evento.

Este documento es el **contrato** entre las partes del sistema. Si cambias algo de aquí, actualízalo en el mismo commit. El plan por fases está en `PLAN.md`.

Llenamos se escribe **desde cero**. RestaurantOS (`LogiQD/logiqd-restaurant-os`) sirve de inspiración funcional; no se copia su código.

## Piezas

| Carpeta | Qué es | Tecnología |
|---|---|---|
| `apps/landing` | Web de venta de Llenamos, estática y sin Firebase (puerto 5181). Sin datos inventados: ver su README | Vite 8, React 19, Tailwind 4, shadcn/ui |
| `apps/web` | Web pública (reservas) y panel del personal | Next.js 16.4 (App Router, Turbopack, `cacheComponents`), React 19, Tailwind 4, SDK web de Firebase 13 |
| `functions` | Lógica de servidor: operaciones sensibles y registro de actividad | Cloud Functions for Firebase (firebase-functions 7, firebase-admin 14), empaquetadas con tsup |
| `packages/core` (`@llenamos/core`) | Lógica compartida sin dependencias de Firebase: dinero, roles, esquemas y motor de reservas | TypeScript + zod |
| `firebase/` | Reglas de Firestore y Storage, índices | — |
| `tests/rules` | Pruebas de las reglas contra el emulador | Vitest + @firebase/rules-unit-testing |
| `scripts/` | Utilidades: `seed.ts` carga el restaurante de demostración | tsx + firebase-admin |

**Next.js 16.4 es más nuevo que lo que conocen los modelos.** Antes de escribir código de Next, lee las guías en `apps/web/node_modules/next/dist/docs/` (ver `apps/web/AGENTS.md`). En particular: `params` y `searchParams` son asíncronos, `middleware` se llama `proxy`, y con `cacheComponents` las rutas son dinámicas por defecto.

## Todo en local

- Proyecto de Firebase: **`demo-llenamos`**. El prefijo `demo-` hace que los emuladores funcionen sin cuenta y sin tocar nada real.
- Puertos: Auth 9099 · Firestore **8085** · Functions 5001 · Storage 9199 · Interfaz de emuladores **4001** (el 4000 lo usa NoMachine y el 4500 Windows, por eso el registro de los emuladores va al 4501) · Web 3000.
- Región de funciones: **`europe-west1`** (en el servidor y en `getFunctions(app, "europe-west1")`).
- Java 21 está instalado en `C:\Program Files\Microsoft\jdk-21.0.13.21-hotspot` (lo necesita el emulador de Firestore). Si `java` no está en el PATH de tu shell, exporta `JAVA_HOME` y añade su `bin`.
- Variables de la web: `apps/web/.env.local` (copia de `.env.example`). Si los puertos del contrato están ocupados, `NEXT_PUBLIC_EMULATOR_HOST` y `NEXT_PUBLIC_{AUTH,FIRESTORE,FUNCTIONS,STORAGE}_EMULATOR_PORT` cambian dónde busca la web los emuladores (por defecto, 127.0.0.1 y los puertos de arriba).

Arranque:

```bash
pnpm install
pnpm funciones:build          # compila functions/lib
pnpm emuladores               # Auth, Firestore, Functions, Storage
pnpm seed                     # restaurante de demostración (con los emuladores en marcha)
pnpm web                      # http://localhost:3000
```

## Datos en Firestore

```
users/{uid}
  displayName, email
  restaurants: { [rid]: { name, role } }        ← solo lo escriben las funciones

restaurants/{rid}
  name, slug, brandColor, currency "EUR", timezone "Europe/Madrid", locale, isDemo
  updatedBy?         uid del último editor cliente (obligatorio en escrituras de cliente)
  changeId?          id de actividad de la última operación administrativa (solo servidor)
  members/{uid}       changeId?, uid, displayName, email, role, locationIds[], active
  locations/{lid}     name, slug, address, city, phone, updatedBy?
    areas/{aid}       name, sortOrder, updatedBy?
    tables/{tid}      name, areaId, seats, shape "rect"|"round", x, y, w, h (0–100), joinableWith[], enabled, updatedBy?
  activity/{id}       action, summary, actorUid, actorName, entity {type,id}|null, createdAt
```

Los tipos y esquemas están en `packages/core/src/model.ts`. Todos los documentos llevan `createdAt` y `updatedAt` (marca de tiempo del servidor).

**Dinero:** siempre entero de céntimos (`Cents`). Nunca decimales.

## Roles y permisos

`owner`, `manager`, `waiter`, `kitchen`, `bar`. La tabla está en `packages/core/src/roles.ts` (`can(role, permiso)`). Se comprueba en tres sitios: la interfaz, las funciones y las reglas. Las tres deben decir lo mismo.

Reglas de acceso (las implementa `firebase/firestore.rules`):

| Ruta | Leer | Escribir desde el cliente |
|---|---|---|
| `users/{uid}` | solo esa persona | nadie (funciones) |
| `restaurants/{rid}` | miembros activos | owner y manager, solo `name`, `brandColor`, `locale`, `updatedAt`, `updatedBy == request.auth.uid` |
| `members/{uid}` | miembros activos | nadie (funciones) |
| `locations`, `areas`, `tables` | miembros activos con acceso a ese local | owner y manager, con validación de campos y `updatedBy == request.auth.uid` en altas y cambios |
| `activity/{id}` | owner y manager | nadie (funciones) |
| Todo lo demás | nadie | nadie |

## Funciones (callables, región europe-west1)

| Nombre | Entrada | Salida | Quién |
|---|---|---|---|
| `crearRestaurante` | `{ name, locationName }` | `{ restaurantId, locationId }` | cualquier persona con sesión; queda como owner |
| `invitarMiembro` | `{ restaurantId, email, displayName, role, password }` | `{ uid }` | owner o manager, y solo roles de `assignableRoles`; reactiva una membresía inactiva con el rol pedido y repone `users/{uid}.restaurants`; `already-exists` solo si está activa |
| `cambiarRolMiembro` | `{ restaurantId, uid, role }` | `{ ok: true }` | owner o manager; nadie se cambia a sí mismo ni deja el restaurante sin owner |
| `desactivarMiembro` | `{ restaurantId, uid }` | `{ ok: true }` | owner o manager; igual que arriba |

Errores: `HttpsError` con código estándar y mensaje en castellano que se pueda enseñar al usuario.

Las callables escriben actividad en la misma transacción que los datos: `restaurant.created`, `member.invited`, `member.reactivated`, `member.roleChanged` y `member.deactivated`, con uid, nombre del autor y resumen en castellano. Crear restaurante registra también el alta del propietario. El `changeId` opcional del restaurante o miembro apunta a su entrada de actividad y solo lo escribe el servidor. Los disparadores omiten el evento cuando aparece o cambia ese campo, evitando duplicados, y siguen registrando cambios de cliente en ajustes, mesas y zonas con autor. Las reglas prohíben modificar `changeId` desde el cliente.

El autor se resuelve primero con el contexto de usuario del evento (`api_key` con `authId`), después con `after.updatedBy` (en borrados, `before.updatedBy`) y finalmente como nulo; el nombre se lee de `users/{uid}.displayName`. Así funciona también cuando el emulador omite el contexto. Los cambios exclusivos de `updatedBy` y fechas no generan actividad. En borrados sin contexto solo se conoce al último editor guardado, que puede no ser quien borra; si no hay uid guardado, el autor es nulo. Las callables con `changeId` y el seed no cambian: el seed no usa outbox y conserva actor nulo. Los esquemas de core no son estrictos y admiten este campo adicional sin cambiar el modelo de lectura. La reactivación conserva `createdAt` y `locationIds` y comprueba los permisos sobre el rol anterior y el solicitado.

## Motor de reservas (`packages/core/src/reservas/`)

Lógica pura, sin Firebase, exportada desde `@llenamos/core`. Ninguna función lee el reloj ni la zona del sistema: `ahora` (ms UTC) y `zonaHoraria` (en la configuración) entran como datos.

**Tiempo.** Las reservas guardan el **instante** de llegada en ms UTC (`inicio`) y su `duracionMinutos`; los solapes se calculan en instantes. Los horarios se escriben en **hora de pared** del local (`"13:30"`). En el adelanto de marzo las horas que no existen no se ofrecen; en el retraso de octubre las que se repiten se ofrecen una vez (la primera).

**Configuración de reservas** (`ConfiguracionReservasSchema`, una por local; en Firestore se guarda en inglés como `ReservationSettings` en `settings/reservations` y llega al motor con `settingsToConfiguracion`, ver «Fase 1»):

| Campo | Qué es |
|---|---|
| `zonaHoraria` | `"Europe/Madrid"` |
| `pasoMinutos` | salto entre horas ofrecidas (15) |
| `semana.{lun…dom}` | turnos del día: `{ nombre, desde, ultimaEntrada, maxComensalesPorFranja?, maxComensalesTurno? }`. Sin turnos = cerrado. Si `ultimaEntrada < desde`, el turno cruza la medianoche y pertenece al día en que empieza |
| `excepciones[]` | `{ tipo: "cerrado", fecha }` o `{ tipo: "horario", fecha, turnos }`. Gana a todo lo demás |
| `cierres[]` | `{ desde, hasta, motivo? }` (vacaciones) |
| `duracion` | `{ porDefectoMinutos, tramos: [{ hastaComensales, minutos }] }` |
| `margenMinutos` | hueco libre entre dos reservas de la misma mesa |
| `maxComensalesPorFranja` | comensales que pueden llegar en una misma franja, o `null` |
| `comensalesMin`, `comensalesMax` | grupos que se aceptan desde la web |
| `antelacionMinimaMinutos`, `antelacionMaximaDias` | plazo para reservar desde la web |
| `maxMesasUnidas`, `plazasPerdidasPorUnion` | cómo se juntan mesas (`joinableWith` se lee en los dos sentidos) |

Los tipos y funciones del motor siguen en castellano. Lo que se guarda en Firestore va en inglés (sección «Fase 1») y se convierte con los adaptadores de `packages/core/src/adapters.ts`.

**Reserva del motor** (`ReservaSchema`): `nombre`, `telefono`, `email|null`, `comensales`, `inicio` (instante), `duracionMinutos`, `estado`, `mesaIds[]` (vacío = sin mesa), `origen` (`web`, `widget`, `telefono`, `presencial`, `importada`), `notas`, `historial[]` de `{ de, a, en, por, motivo }`. No se guarda tal cual: el documento de `reservations/{id}` es `Reservation` (en inglés) y el motor recibe lo que necesita con `reservationToOcupacion`.

**Estados** (`TRANSICIONES_RESERVA`):

| Desde | Puede pasar a |
|---|---|
| `pendiente` | `confirmada`, `sentada`, `cancelada`, `no_presentada` |
| `confirmada` | `sentada`, `cancelada`, `no_presentada` (esta solo a partir de la hora de la reserva) |
| `sentada` | `terminada` |
| `no_presentada` | `sentada` (llegó tarde) |
| `terminada`, `cancelada` | nada (finales) |

Ocupan mesa: `pendiente`, `confirmada`, `sentada` (si se alarga, hasta `ahora`). Cuentan para la capacidad: todas menos `cancelada` y `no_presentada`.

**Funciones principales:** `calcularDisponibilidad` (franjas de un día con `disponible` y `motivo`), `horasDisponibles`, `proponerMesas` (propuestas ordenadas con su explicación y descartes con su motivo; sugiere, no asigna), `turnosDelDia`, `franjasDelDia`, `duracionParaGrupo`, `cambiarEstado`, `comprobarCambioEstado`.

## Fase 1 · Reservas (contrato)

Reparto y orden de trabajo en `docs/tareas/fase-1-reparto.md`. Los documentos guardados van **en inglés**; el motor sigue en castellano y se usa a través de adaptadores (`settingsToConfiguracion`, `reservationToOcupacion`). Las horas guardadas son `Timestamp` de Firestore; en core y en las funciones se trabaja en ms UTC.

### Módulos y planes

- Módulos (`MODULES`): `reservations` (Reservas), `floor` (Sala y comandero), `kitchen` (Cocina y barra), `pos` (Caja), `repite` (Repite).
- Planes (`PLANS`, **provisionales, sin precio**): `reservas` → `reservations`; `sala` → `reservations`, `floor`, `kitchen`; `completo` → todos.
- En `restaurants/{rid}`: `plan`, `moduleOverrides: { [module]: boolean }` (encender o apagar uno aparte del plan) y `activeModules: string[]` (calculado con `activeModulesFor`). **Los tres solo los escribe el servidor** con `cambiarPlan`, que solo puede usar el equipo de LogiQD (claim `logiqd: true`). Un restaurante sin `plan` se trata como `completo` hasta que se migre.
- La interfaz, las funciones y las reglas comprueban el módulo igual que los roles.

### Permisos nuevos (`roles.ts`)

| Permiso | owner | manager | waiter | kitchen | bar |
|---|---|---|---|---|---|
| `reservas.ver`, `reservas.gestionar` (ya existen) | ✓ | ✓ | ✓ | | |
| `reservas.configurar` (horarios y políticas) | ✓ | ✓ | | | |
| `plano.editar` | ✓ | ✓ | | | |
| `clientes.ver`, `clientes.editar` (notas, alergias, etiquetas) | ✓ | ✓ | ✓ | | |
| `mensajes.ver` | ✓ | ✓ | | | |
| `reservas.importar` | ✓ | ✓ | | | |

### Datos

```
restaurants/{rid}
  plan, moduleOverrides, activeModules[]                       ← solo servidor
  customers/{cid}     name, phone (E.164), email|null, language, visits, noShows, cancellations,
                      lastVisitAt|null, notes, allergies, tags[], updatedBy?
                      cid = customerIdFor(rid, phone). Estadísticas: solo servidor. notes, allergies, tags: personal con clientes.editar
  messages/{mid}      channel "email"|"whatsapp", to, template, language, data{}, reservationId|null, waitlistId|null, takeawayId?,
                      status "queued"|"sent"|"captured"|"not_configured"|"failed"|"cancelled",
                      sendAt, attempts, lastError|null, provider|null, providerMessageId|null,
                      rendered { subject|null, body }|null                                  ← solo servidor
  locations/{lid}
    settings/reservations   ReservationSettings (abajo)                                     ← solo servidor (guardarConfiguracionReservas)
    reservations/{id}       Reservation (abajo)                                             ← solo servidor
    waitlist/{wid}          guestName, phone, email|null, language, partySize, date "AAAA-MM-DD", from "HH:MM", to "HH:MM",
                            status "waiting"|"offered"|"booked"|"expired"|"cancelled",
                            offer { startAt, expiresAt, tokenHash }|null, customerId, source "web"|"widget"|"staff"   ← solo servidor
publicRestaurants/{slug}    restaurantId, name, brandColor, locale, timezone, bookingEnabled, bookingDisabledReason,
                            locations[{ id, name, address, city, phone }],
                            minPartySize, maxPartySize, maxAdvanceDays, deposit { mode, amountCents, fromPartySize },
                            cancellationFreeUntilHours                                       ← solo servidor; lo lee cualquiera
```

**`ReservationSettings`** (equivale a la `ConfiguracionReservas` del motor más las políticas):
`timezone`, `stepMinutes`, `week { mon…sun: [{ name, from, lastEntry, maxGuestsPerSlot?, maxGuestsPerShift? }] }`, `exceptions [{ type: "closed", date, reason? } | { type: "hours", date, shifts, reason? }]`, `closures [{ from, to, reason? }]`, `duration { defaultMinutes, tiers [{ upToGuests, minutes }] }`, `bufferMinutes`, `maxGuestsPerSlot|null`, `minPartySize`, `maxPartySize`, `minNoticeMinutes`, `maxAdvanceDays`, `maxJoinedTables`, `seatsLostPerJoin`, y además: `publicBooking` (bool), `autoConfirm` (bool: si no, las reservas de la web quedan `pending`), `deposit { mode: "none"|"perPerson", amountCents, fromPartySize }`, `cancellation { freeUntilHours }`, `reminders { dayBefore, hour "HH:MM" }`, `reviews { enabled, googleReviewUrl|null }`, `waitlist { enabled, offerMinutes }`. Sin documento, se usa `defaultReservationSettings()`: los horarios de `configuracionReservasInicial` y políticas apagadas (`publicBooking: false`, `autoConfirm: false`, señal `none`, `cancellation.freeUntilHours: 0`, recordatorio apagado a las `18:00`, reseñas apagadas y lista de espera apagada con `offerMinutes: 30`).

**`Reservation`**: `guestName`, `phone` (E.164), `email|null`, `language` (`es`|`ca`|`en`), `partySize`, `startAt`, `durationMinutes`, `status` (`pending`|`confirmed`|`seated`|`finished`|`cancelled`|`no_show`, mismas transiciones que el motor), `tableIds[]`, `suggestedTableIds[]`, `suggestionReason|null`, `source` (`web`|`widget`|`phone`|`walk_in`|`import`|`waitlist`), `notes` (del personal), `guestNotes` (del cliente), `customerId`, `reference` (6 caracteres, único por restaurante), `manageTokenHash` (sha256 del token del enlace; el token solo va en el enlace), `deposit { status: "none"|"required"|"not_configured"|"paid"|"refunded"|"failed", amountCents, checkoutSessionId|null }`, `history [{ from, to, at, by|null, reason|null }]`, `createdBy|null`.

### En core (`@llenamos/core`)

Precisiones del contrato. Todo se exporta desde `@llenamos/core`.

| Archivo | Qué hay |
|---|---|
| `timestamp.ts` | `TimestampSchema`, `timestampToMillis`, `MillisSchema` |
| `reservation-settings.ts` | `ReservationSettingsSchema`, `ShiftSchema`, `WeekSchema`, `ExceptionSchema`, `ClosureSchema`, `DepositPolicySchema`, `depositAmountFor`, `defaultReservationPolicies` |
| `reservation-model.ts` | `ReservationSchema`, `ReservationStatusSchema`, `ReservationSourceSchema`, `DepositSchema`, `StatusChangeSchema`, `CustomerSchema`, `CustomerEditableSchema`, `WaitlistEntrySchema`, `PublicRestaurantSchema` y sus `xxxForWrite` |
| `message-model.ts` | `MessageSchema`, `MessageChannelSchema`, `MessageTemplateSchema`, `MessageStatusSchema`, `MessageRequestSchema`, `queuedMessage`, `messageForWrite` |
| `adapters.ts` | `settingsToConfiguracion`, `configuracionToSettings`, `defaultReservationSettings`, `reservationToOcupacion`, `tableToMesa`, `statusToEstado`, `estadoToStatus`, `RESERVATION_TRANSITIONS`, `canTransition`, `checkTransition`, `nextStatuses`, `applyStatusChange`, `slotStartAt`, `disponibilidadToOutput`, `asignacionToOutput` |
| `modules.ts` | `MODULES`, `MODULE_LABEL`, `PLANS`, `PLAN_LABEL`, `PLAN_MODULES`, `activeModulesFor`, `restaurantModules`, `hasModule` |
| `api.ts` | `CALLABLES`, `CALLABLE_REGION`, `XxxInputSchema` y `XxxOutputSchema` de cada callable, `CALLABLE_SCHEMAS`, `ImportRowSchema`, `parseImportRow` |
| `phone.ts`, `ids.ts`, `sha256.ts` | `normalizePhone`, `PhoneInputSchema`, `customerIdFor`, `reservationReference`, `linkToken`, `sha256Hex` |

- **Horas.** Los esquemas de lectura aceptan de forma explícita lo que puede llegar de Firestore: ms enteros, `Date`, cualquier objeto con `toMillis()` (el `Timestamp` web y el de admin), `{ seconds, nanoseconds }` y `{ _seconds, _nanoseconds }`; y devuelven siempre ms. Un `serverTimestamp()` sin resolver (`null`) es un error. Para escribir, `reservationForWrite(r, Timestamp.fromMillis)` (y los de cliente, lista de espera y mensaje) convierten los ms. `createdAt` y `updatedAt` no están en los esquemas: los pone el servidor y se ignoran al leer.
- **Teléfonos.** `normalizePhone(raw, "34")` acepta espacios, guiones, puntos, paréntesis, `+` y `00`, y devuelve E.164 o lanza `InvalidPhoneError` con un mensaje para enseñar. En las entradas de las callables lo hace `PhoneInputSchema`.
- **Id del cliente.** `customerIdFor(rid, phone)` son los 20 primeros caracteres hexadecimales del SHA-256 de `"{rid}:{phone}"`, con una implementación pura de SHA-256 (`sha256Hex`, da lo mismo que la de Node) para que salga igual en el navegador y en las funciones.
- **Referencia.** `reservationReference(bytes)`: 6 caracteres de `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (sin 0, 1, O, I ni L) y sin sesgo; pásale 16 bytes aleatorios. La unicidad por restaurante la comprueba quien guarda. Lo que escribe una persona se normaliza con `normalizeReference` (mayúsculas, sin espacios ni guiones).
- **Tokens de enlace.** `linkToken(32 bytes)` da 43 caracteres base64url; se guarda `sha256Hex(token)` en `manageTokenHash` y en `offer.tokenHash`.
- **Fecha y hora en las callables.** `date` es el día de servicio y `time` la hora de pared de la franja, tal como las devuelve `consultarDisponibilidad`. La función saca el instante con `slotStartAt(config, date, time)`, que resuelve los turnos que cruzan la medianoche y los cambios de hora; una hora fuera de turno solo la puede poner el personal (`inShift: false`).
- **Campo trampa.** `website` (debe ir vacío) en `crearReservaPublica`, `gestionarReservaPublica`, `apuntarseListaEspera` y `aceptarOfertaListaEspera`. Todas las entradas son estrictas: un campo de más es un error.
- **Señal.** `DepositPolicySchema` es la política (`settings.deposit` y `publicRestaurants.deposit`: `mode`, `amountCents` por persona y `fromPartySize`); `DepositSchema` es el estado de la señal de una reserva. El total sale de `depositAmountFor(policy, partySize)`.
- **Restaurante público.** Lleva además `timezone` (para el calendario) y `bookingDisabledReason` (`"module_off"`, `"public_booking_off"` o `null`), para que la página diga por qué no se puede reservar. `bookingEnabled` es `true` solo con el módulo `reservations` activo y `publicBooking` encendido.
- **Disponibilidad pública.** Franjas con `time`, `wallDate`, `startAt`, `shift`, `available` y `reason` (`min_notice`, `max_advance`, `slot_capacity`, `shift_capacity`, `no_table`), más `waitlistEnabled`. Ningún dato de otras reservas.
- **Importar.** Las filas llegan tal cual de la hoja (`rows`, de 1 a 500) y se validan una a una con `parseImportRow`, que acepta fechas `9/11/2026`, horas `9:30` y estados en castellano. Los errores van por fila y campo.
- **Mensajes.** `data` solo admite valores simples (texto, número, sí o no, `null`). `to` es un correo en el canal `email` y un E.164 en `whatsapp`. `enqueueMessage` recibe un `MessageRequest` y guarda `queuedMessage(request)`.
- **Cliente.** `allergies` es texto libre; `tags`, hasta 20 etiquetas de 30 caracteres.

### Reglas (nuevas)

| Ruta | Leer | Escribir desde el cliente |
|---|---|---|
| `restaurants/{rid}` | igual | igual, y nunca `plan`, `moduleOverrides`, `activeModules` |
| `settings/reservations` | miembros activos con acceso al local | nadie |
| `reservations`, `waitlist` | miembros con `reservas.ver`, acceso al local y módulo `reservations` | nadie |
| `customers` | miembros con `clientes.ver` y módulo `reservations` | con `clientes.editar`: solo `notes`, `allergies`, `tags`, `updatedAt`, `updatedBy` |
| `messages` | miembros con `mensajes.ver` | nadie |
| `publicRestaurants/{slug}` | cualquiera | nadie |

### Funciones nuevas (callables, `europe-west1`)

Entradas y salidas: esquemas en `packages/core/src/api.ts`. Errores `HttpsError` en castellano. Las públicas no piden sesión, llevan campo trampa (`website`, debe ir vacío) y límite de intentos por teléfono.

| Nombre | Quién | Hace | Agente |
|---|---|---|---|
| `consultarDisponibilidad` | cualquiera | `{ slug, locationId, date, partySize }` → franjas con `available` y motivo, sin datos personales | R1 |
| `crearReservaPublica` | cualquiera | crea la reserva (`web`/`widget`), cliente y mensajes; devuelve `reference`, `status`, `manageToken` y estado de la señal | R1 |
| `verReservaPublica`, `gestionarReservaPublica` | quien tenga el enlace | ver; `confirm` o `cancel` | R1 |
| `crearReserva` | `reservas.gestionar` | por teléfono o en el local; puede saltarse los límites de la web | R1 |
| `cambiarEstadoReserva`, `asignarMesas`, `moverReserva`, `proponerMesasReserva` | `reservas.gestionar` | estado, mesas (sin solapes), mover, propuestas explicadas | R1 |
| `guardarConfiguracionReservas` | `reservas.configurar` | valida con zod y guarda `settings/reservations` | R1 |
| `importarReservas` | `reservas.importar` | hasta 500 filas; devuelve creadas y errores por fila | R1 |
| `cambiarPlan` | claim `logiqd` | `plan`, `moduleOverrides`, recalcula `activeModules` | R1 |
| `apuntarseListaEspera`, `aceptarOfertaListaEspera` | cualquiera | lista de espera y aceptar una oferta | R2 |
| `iniciarPagoSenal` | quien tenga el enlace | sesión de Stripe Checkout, o «pagos no configurados» | R2 |
| `procesarMensajesPendientes` | `mensajes.ver` o claim `logiqd` | envía o captura los mensajes vencidos | R2 |

HTTP: `whatsappWebhook`, `stripeWebhook` (R2). Programada: `mensajesProgramados` cada 5 minutos (R2; en el emulador no corre sola).

**Mensajes (outbox).** Quien crea o cambia una reserva encola sus mensajes en la misma transacción con `enqueueMessage(tx, rid, { channel, to, template, language, data, reservationId|waitlistId, sendAt })` de `functions/src/messages/enqueue.ts` (lo escribe R1; R2 lo usa). Por cada reserva con correo se encola por correo, y con teléfono por WhatsApp. Plantillas: `confirmation`, `pending`, `reminder`, `cancellation`, `waitlist_offer`, `deposit_request`, `review_request`.

Detalles de persistencia del backend de reservas (R1): `restaurants/{rid}/reservationReferences/{reference}` guarda `{ locationId, reservationId }` y garantiza referencias únicas entre locales. `locations/{lid}/reservationLocks/current` guarda un contador `revision`: toda transacción que consume o libera capacidad lee este documento antes de escribir y lo incrementa en la misma operación. Ambos son privados del servidor y las reglas deniegan su acceso al cliente. R2 debe usar el mismo bloqueo al aceptar ofertas para coordinarse con las altas de R1. Las ofertas de lista de espera vigentes cuentan como ocupación sin mesa asignada.

Los mensajes de R1 incluyen en `data`: `guestName`, `restaurantName`, `locationName`, `reference`, `startAt` (ms), `partySize`, `timezone`, `amountCents`, `slug`, `locationId`; al crear, también `manageUrl` (ruta relativa del enlace de gestión). En cambios posteriores no se puede reconstruir el token desde su hash. Mover o cambiar de estado anula los mensajes `queued` anteriores dentro de la transacción y programa los nuevos que correspondan. La cancelación después del plazo gratuito se permite y conserva la política visible; no se ejecutan devoluciones automáticas.

## Fase 2 · Sala y cocina

Este apartado fija el contrato de la fase 2, implementada en core, callables, disparadores, reglas, Storage y pantallas. El recorrido de integración con emuladores reales y sus capturas está en `docs/diseno/capturas/fase2/README.md`. Se mantienen `europe-west1`, `demo-llenamos`, céntimos enteros con IVA incluido, `Timestamp` en Firestore y ms UTC en core y callables. El reloj y la zona horaria entran como argumentos; core no importa Firebase.

### Módulos y permisos

`floor` habilita carta administrable, sesiones de mesa, comandero, tareas y para llevar; `kitchen` habilita estaciones y pantallas de cocina y barra. Las operaciones de servicio necesitan `floor`; las acciones de preparación por estación necesitan además `kitchen`. Con `floor` y sin `kitchen`, se toman pedidos y la sala puede servir directamente; el servidor planifica las líneas nuevas pasando estaciones vacías a `planOrderLines`. Las antiguas mantienen sus datos y la sala puede marcarlas servidas. Activar solo `kitchen` no permite crear pedidos ni saltarse `floor`. Apagar módulos nunca borra el historial.

La entrada «Sala» y `/panel/sala` requieren `floor`, también cuando existe información de reservas de fase 1. El plan `reservas` conserva su plano y asignación de mesas dentro de Reservas y el editor de Plano, sin abrir pantallas de servicio de sala o cocina.

La carta pública se puede consultar aunque `floor` esté apagado, pero sus opciones de pedir y avisar quedan deshabilitadas. La comprobación efectiva siempre lee los módulos actuales del restaurante, incluso si la proyección pública aún no se ha actualizado. Los horarios de recogida reutilizan `settings/reservations` como datos internos sin exigir el módulo `reservations`; sentar o terminar una reserva sí requiere ese módulo y sus permisos. No hace falta `pos` en esta fase.

Tabla de `roles.ts`, que deben repetir la interfaz, las funciones y las reglas:

| Permiso | owner | manager | waiter | kitchen | bar | Módulo |
|---|---|---|---|---|---|---|
| `sala.ver`, `sala.gestionar` | ✓ | ✓ | ✓ | | | floor |
| `comandas.tomar` | ✓ | ✓ | ✓ | | | floor |
| `comandas.anular` | ✓ | ✓ | | | | floor |
| `tareas.atender` | ✓ | ✓ | ✓ | | | floor |
| `carta.editar` | ✓ | ✓ | | | | floor |
| `carta.agotar` | ✓ | ✓ | ✓ | ✓ | ✓ | floor; cocina y barra necesitan también kitchen |
| `sala.configurar` | ✓ | ✓ | | | | floor; gestionar estaciones necesita kitchen |
| `cocina.ver`, `cocina.preparar` | ✓ | ✓ | | ✓ | | floor y kitchen |
| `barra.ver`, `barra.preparar` | ✓ | ✓ | | | ✓ | floor y kitchen |

Toda operación del personal comprueba sesión de Auth, miembro activo y `locationIds` vacío o que incluya el local. El rol `kitchen` trabaja únicamente líneas con `stationKind: "kitchen"`; `bar`, únicamente `"bar"`. Pueden marcar agotados de platos de sus estaciones, resolviendo la estación por defecto igual que al crear líneas. Owner y manager trabajan ambas. El camarero puede marchar y servir, pero para anular algo ya marchado debe intervenir owner o manager con motivo. `FASE2_ACCESS` expresa el permiso y módulo base de cada callable; `per_line` exige resolver cada transición con `lineTransitionPermissions` y comprobar también los módulos y la estación. No basta con comprobar el nombre de la callable.

### Datos y autores de las escrituras

Todas las rutas siguientes bajo un local son `restaurants/{rid}/locations/{lid}`. **Ningún documento nuevo admite escrituras directas de cliente**. Las callables son las únicas escritoras de las decisiones del personal o de la mesa; toman el autor de Auth, nunca de la entrada. Los campos derivados los escribe el servidor. Todos los documentos llevan `createdAt`, `updatedAt` de servidor y, para operaciones humanas autenticadas, `updatedBy` calculado por la función. Público y sistema llevan autor nulo en los campos que lo admiten. Los metadatos comunes se omiten en los esquemas de lectura y en la relación siguiente.

```
restaurants/{rid}
  customers/{cid}                    spentCents? (ausente = 0)                   ← solo servidor
  takeawayReferences/{reference}     locationId, takeawayId                     ← solo servidor, índice privado
  locations/{lid}
    settings/floor                  FloorSettings
    menuCategories/{categoryId}      MenuCategory
    menuItems/{itemId}               MenuItem
    dailyMenus/{dailyMenuId}         DailyMenu
    stations/{stationId}             Station
    tableSessions/{sessionId}        TableSession
    orders/{orderId}                 Order
    orderLines/{lineId}              OrderLine
    floorTasks/{taskId}              FloorTask
    takeaways/{takeawayId}           Takeaway
    tableTokens/{tableId}            tokenHash|null, tokenSecret?, rotatedAt, revokedAt?                       ← solo servidor, secreto
    takeawaySecrets/{takeawayId}    tokenSecret                               ← solo servidor, secreto del seguimiento
    serviceLocks/{id}                revision                                   ← solo servidor, recogida/publicación
    reservationSessions/{id}        sessionId                                  ← solo servidor, una sesión por reserva
    taskKeys/{hash}                  taskId                                     ← solo servidor, exclusión por dedupeKey
    spendContributions/{id}          customerId, amountCents                     ← solo servidor, aportación contabilizada
publicMenus/{publicMenuId}           PublicMenu                                 ← solo servidor, lectura pública
```

`publicMenuId(rid, lid)` es `sha256Hex(JSON.stringify([rid, lid]))`: no se concatena con un separador que también pueda estar dentro de los ids. Cada local tiene su propia carta. Los índices privados y bloqueos anteriores son detalles del backend, no documentos que deba leer la web. Las claves de bloqueo, tareas y gasto se construyen de forma determinista.

**Carta.** Todo texto de nombre, descripción, variante, grupo, opción y sección usa `{ es, ca, en }`. El castellano es obligatorio para nombres; `ca` y `en` vacíos muestran `es` mediante `localize`. Las descripciones pueden quedar vacías. `carta/i18n.ts` aporta las plantillas de interfaz en los tres idiomas y las etiquetas de pases, problemas y alérgenos.

| Documento | Campos | Quién decide y quién escribe |
|---|---|---|
| `MenuCategory` | `name`, `description`, `sortOrder`, `active` | owner o manager mediante `guardarCategoriaCarta`; servidor guarda |
| `MenuItem` editable | `categoryId`, `name`, `description`, `sortOrder`, `priceCents`, `variants [{ id, name, priceCents, soldOut? }]`, `modifierGroups [{ id, name, min, max, options [{ id, name, priceCents, allergens[], soldOut }] }]`, `allergens[]`, `traces[]`, `dietary[]`, `photoPath|null`, `course`, `stationId|null`, `prepMinutes|null`, `taxRate`, `selfOrder`, `takeaway`, `active`, `featured?`, `allergensReviewed?` | owner o manager mediante `guardarPlato`; el servidor comprueba referencias al local y la ruta de foto |
| `MenuItem` controlado | `soldOut`, `version`, `updatedBy` | agotado mediante `marcarAgotado`; `version` y autor calculados solo por servidor. Los agotados de variantes y opciones también se cambian con `marcarAgotado` |
| `DailyMenu` editable | `name`, `description`, `includes`, `priceCents`, `days[]` (`mon`…`sun`), `from`, `to`, `sections [{ id, name, course, min, max, choices [{ itemId, variantId|null, supplementCents }] }]`, `sortOrder`, `taxRate`, `selfOrder`, `takeaway`, `active` | owner o manager mediante `guardarMenuDia`; servidor comprueba platos y variantes del local |
| `DailyMenu` controlado | `version`, `updatedBy` | solo servidor |
| `Station` | `name`, `kind: "kitchen"|"bar"`, `sortOrder`, `targetMinutes`, `pickup`, `active` | owner o manager mediante `guardarEstacion`; servidor guarda |

Los ids de opciones son únicos en todo el plato, porque el pedido lleva `optionIds[]` sin grupo. Los precios individuales están entre 0 y 10.000.000 céntimos; el precio calculado de una línea puede superar ese máximo al sumar extras. Las cantidades van de 1 a 99; como mucho 50 líneas principales por pedido. Los totales deben seguir siendo enteros seguros. Una variante es obligatoria si el plato tiene variantes y **sustituye** al precio base; cada extra elegido se suma una vez, respetando mínimo y máximo del grupo. Los platos inactivos o agotados, las variantes agotadas y las opciones agotadas no se pueden pedir. `Variant.soldOut?` ausente equivale a disponible, no altera la versión y se comprueba también en las selecciones del menú del día. Una variante agotada no agota las demás. No se borran fichas para retirar productos: se desactivan.

`ALLERGENS` contiene los 14 grupos del anexo II del Reglamento UE 1169/2011: `gluten`, `crustaceans`, `eggs`, `fish`, `peanuts`, `soy`, `milk`, `nuts`, `celery`, `mustard`, `sesame`, `sulphites`, `lupin`, `molluscs`. `allergens` declara presencia; `traces`, posibles trazas; `dietary` permite `vegetarian` y `vegan`. Es información introducida por el restaurante, sin deducir ausencias ni garantizar que un plato sea seguro para una alergia. Los extras añaden sus alérgenos. Los grupos conservan el detalle de cereales y frutos de cáscara en la descripción cuando corresponda.

En platos y menús, `updatedBy` admite `null` para escrituras del servidor sin autor (por ejemplo, el seed). Las escrituras de cliente siguen exigiendo su uid en las reglas.

`version` empieza en 1. `nextItemVersion` la incrementa al cambiar precio base, variantes o composición y precios de extras; `nextDailyMenuVersion`, al cambiar precio, secciones, elecciones o suplementos. Cambiar nombres o agotados no la incrementa. Cada línea guarda nombres, variante, extras, versión y precios **congelados al enviar**; cambiar la carta nunca recalcula pedidos existentes. La aceptación de un pedido pendiente valida el destino y sus estados, conserva su precio y no vuelve a cobrar el precio nuevo. Un plato agotado después del envío se puede rechazar con motivo; no se sustituye silenciosamente.

El menú del día cobra `(precio fijo + suplementos + extras) × cantidad`; las variantes incluidas no vuelven a cobrarse. Cada selección usa el pase de su sección. `days/from/to` se comprueban en la hora del local, con el día de inicio si cruza medianoche. Para llevar se comprueba el menú contra la **hora de recogida**, también en el navegador; para mesa y personal, contra el instante de envío. El canal para llevar exige `takeaway` también en pedidos del personal; el canal mesa exige `selfOrder`. Los componentes incluidos en un menú se autorizan por su sección, aunque no se puedan pedir sueltos. En pedidos públicos la carta validada es la proyección vigente construida desde los documentos internos leídos en la transacción, para que una categoría oculta tampoco permita pedir platos sueltos adivinando su id.

**Búsqueda y preferencias de carta.** `featured?` marca la sugerencia de la casa y `allergensReviewed?` declara que el restaurante ha revisado presencia, trazas y extras; ambos ausentes equivalen a false. Se editan con `guardarPlato` y se publican sin cambiar la versión de precio. `filterPublicMenu` busca nombre y descripción en el idioma mostrado, sin distinguir acentos o mayúsculas, limita por categoría y excluye alérgenos, trazas y cualquier extra declarado. Al excluir se ocultan también las fichas sin revisión, con contador de ocultos y aviso de información incompleta. Los menús se ocultan con exclusiones porque sus acompañamientos libres no tienen una declaración completa. No se afirma seguridad alimentaria. Limpiar filtros repone el catálogo. El navegador recuerda el idioma público con `llenamos:public:language`; `?lang=es|ca|en` tiene prioridad y la preferencia sigue funcionando entre carta, mesa y seguimiento. El panel sigue en castellano.

Cambiar o limpiar los filtros cierra las opciones del plato que se estuviera eligiendo, para que no siga disponible en ese bloque después de quedar oculto. Los filtros no borran las líneas ya añadidas al pedido.

**`FloorSettings`.** Owner o manager decide todos los campos mediante `guardarConfiguracionSala`, y el servidor los guarda: `selfOrder { enabled, requireApproval, callWaiter, requestBill }`, `firing { mode: "by_course"|"all_at_once", autoFireNextCourse }`, `targets { defaultPrepMinutes, pickupMinutes, callWaiterMinutes, billMinutes, approveMinutes, customMinutes }`, `takeaway { enabled, publicOrdering, autoAccept, stepMinutes, minNoticeMinutes, maxOrdersPerSlot, prepLeadMinutes }`, `defaultStationId|null`. Sin documento se usa `defaultFloorSettings()`: pedir y para llevar apagados, aprobación requerida, pases por turno sin marcha automática, preparación 15 min, recogida 3, llamada 3, cuenta 5, aprobación 3, tarea 10; recogida cada 15 min, antelación 30, cuatro pedidos por franja, cocina 20 min antes y estación por defecto nula. Llamar y pedir cuenta tienen interruptores propios, independientes de `selfOrder.enabled`.

**Sesión de mesa (`TableSession`).** El personal aporta mesas, comensales, responsable y notas; el servidor resuelve reserva y cliente, valida y escribe todos los campos: `status`, `tableIds[]` (1 a 8, sin repetir), `label`, `guests` (1 a 200), `reservationId|null`, `customerId|null`, `guestName|null`, `waiterUid|null`, `waiterName|null`, `notes`, `openedAt`, `openedBy|null`, `closedAt|null`, `closedBy|null`, `billRequestedAt|null`, `mergedInto|null`, `totalCents`, `lineCount`, `unservedCount`, `history [{ from, to, at, by|null, reason|null }]`. El responsable debe ser miembro activo con acceso al local y permiso de sala. Etiqueta y totales son derivados, nunca entrada del móvil.

**Comanda (`Order`).** Es un envío de una vez: `sessionId|null`, `takeawayId|null` (exactamente un destino al crear), `source: "staff"|"table"|"takeaway_web"`, `status`, `lineIds[]` (solo principales), `totalCents`, `note`, `language`, `fire: "auto"|"all"|"hold"`, `placedAt`, `createdBy|null`, `decidedBy|null`, `decidedAt|null`, `rejectReason|null`. Cliente o personal elige líneas y nota; el servidor determina ids, origen, estado, precio y autores. `orders.sessionId` conserva el destino de origen como trazabilidad cuando una separación reparte sus líneas; el destino **actual** y los totales se consultan siempre en `orderLines`. `Order.totalCents` conserva el importe enviado; las anulaciones afectan a los totales de sesión, no a ese registro histórico.

**Línea (`OrderLine`).** Solo el servidor escribe: `orderId`, `sessionId|null`, `takeawayId|null`, `label`, `kind: "item"|"menu"|"menu_component"`, `parentLineId|null`, `position`, `itemId|null`, `dailyMenuId|null`, `sectionId|null`, `version`, `name`, `variant { id, name, priceCents }|null`, `modifiers [{ groupId, optionId, name, priceCents }]`, `quantity`, `unitPriceCents`, `totalCents`, `notes`, `guest|null`, `course|null`, `stationId|null`, `stationKind|null`, `targetMinutes|null`, `status`, `fireAt|null`, `placedAt`, `firedAt|null`, `startedAt|null`, `readyAt|null`, `servedAt|null`, `cancelReason|null`, `history`, `createdBy|null`. Pase, estación y tiempo se congelan al enviar. El personal puede cambiar el pase en la entrada de una línea suelta; los públicos no. La nota es la que escribe quien pide y se muestra a la estación; no se copian notas privadas de la reserva o del cliente.

`planOrderLines` convierte un menú en una línea padre con el precio fijo y componentes con sus suplementos y extras, multiplicados por la misma cantidad. La suma de padre e hijos coincide con el total calculado, **sin duplicar suplementos**. El estado del padre lo calcula `menuLineStatus` a partir de sus hijos. Las anulaciones parciales de componentes descuentan su suplemento y extras; el precio fijo sigue hasta anular todos los componentes. `sessionTotals` suma todas las líneas no anuladas, incluidas las pendientes; cuenta principales en `lineCount` y platos reales aún sin servir en `unservedCount`. Las pantallas dicen cuánto está pendiente de aprobación; no lo presentan como cobro.

**Tarea (`FloorTask`).** `type: "pickup"|"call_waiter"|"bill_request"|"approve_order"|"custom"`, `status`, `sessionId|null`, `takeawayId|null`, `tableIds[]`, `label`, `orderId|null`, `stationId|null`, `lineIds[]`, `note`, `dedupeKey|null`, `count`, `openedAt`, `dueAt`, `createdBy|null`, `claimedBy|null`, `claimedByName|null`, `claimedAt|null`, `doneAt|null`, `doneBy|null`. La llamada pública aporta el tipo y su enlace; una tarea manual aporta nota y destino. El servidor calcula todo lo demás. `taskDedupeKey` agrupa recogida por destino y estación, llamada/cuenta por destino y aprobación por comanda. Mientras esté abierta o cogida, se amplía esa tarea con líneas distintas o `count + 1`, sin reiniciar su plazo ni quitar su dueño. Para `custom` no hay agrupación. `taskKeys/{sha256Hex(dedupeKey)}` se lee y actualiza en la transacción para impedir dos tareas activas de la misma clave.

**Para llevar (`Takeaway`).** El solicitante aporta contacto, idioma, notas, hora y líneas; el servidor normaliza y escribe `guestName`, `phone` (E.164), `email|null`, `language`, `customerId`, `pickupAt`, `status`, `reference`, `manageTokenHash`, `source: "phone"|"walk_in"|"web"`, `notes`, `totalCents`, `orderIds[]`, `readyAt|null`, `pickedUpAt|null`, `cancelReason|null`, `history`, `createdBy|null`. La referencia de seis caracteres es única por restaurante y usa un índice privado distinto del de reservas; el documento guarda el hash del token y devuelve el token al crear. El servidor conserva además el secreto en `takeawaySecrets/{id}` para componer los avisos de aceptación y listo sin cambiar el enlace original. Ningún cliente puede leer esa colección directamente. Se crea cliente si falta, sin inventar visitas de reserva.

**Carta pública (`PublicMenu`).** `buildPublicMenu` produce `restaurantId`, `locationId`, `restaurantName`, `locationName`, `brandColor`, `timezone`, `currency: "EUR"`, `categories[]`, `items[]`, `dailyMenus[]`, `selfOrder { enabled, requireApproval, callWaiter, requestBill }`, `takeaway { enabled }`. Categorías y platos activos conservan sus datos de presentación, precio, versión, opciones, alérgenos, fotos y disponibilidad por canal; no llevan estaciones, tiempos, `taxRate`, autores ni notas privadas. Los menús solo incluyen opciones activas y salen completos si sus secciones siguen siendo válidas. Los platos exclusivos de un menú se incluyen para calcular extras y alérgenos, marcados como no disponibles sueltos y fuera de las categorías visibles. `publicMenuSections` y `publicMenuCatalog` sirven para mostrar y calcular en el navegador. El servidor reconstruye la misma proyección al validar, sin fiarse de una copia pública atrasada.

### Custodia y reimpresión de QR

`regenerarQrMesa` conserva el secreto claro como `tableTokens/{tableId}.tokenSecret` bajo custodia del servidor, junto al hash de verificación. Estas rutas siguen sin lectura ni escritura directa de cliente, incluso para owner y manager. Solo las callables con `sala.configurar`, sesión activa, acceso al local y módulo `floor` entregan el secreto. `recuperarQrMesa` devuelve el enlace vigente sin rotación ni cambios de servicio. `importarQrMesa` comprueba el token original contra su hash y conserva ese secreto para futuras recuperaciones. Un QR anterior que solo tenga hash no se puede reconstruir: se importa su enlace desde la placa o archivo original; si se perdió, se debe generar otro expresamente. Nunca se rota durante una recuperación fallida.

`revocarQrMesa` pone hash y secreto a null y registra `revokedAt`, sin crear un sustituto. La validación existente por hash rechaza ese enlace inmediatamente. Regenerar vuelve a crear un token, borra la revocación y deja inválidas las placas anteriores. El panel permite hasta ocho mesas y descarga placas SVG vectoriales y PNG de 1200 × 1480 con zona de silencio del QR, nombre de mesa, restaurante y marca Llenamos. Todo se genera en el navegador sin enviar secretos a un servicio de QR externo.

### Avisos de recogida en la cola existente

`messages` admite `takeawayId?` y dos plantillas nuevas: `takeaway_accepted` y `takeaway_ready`, traducidas a es, ca y en. Al crear una recogida aceptada o pasar de pendiente a aceptada se encola la primera; al quedar todos los platos listos se encola la segunda. La reconciliación usa claves deterministas por local, pedido, plantilla y canal, en la misma transacción que el estado. Deshacer preparación y volver a listo no repite el aviso. Los pedidos pendientes aún no generan aceptación. Los pedidos anteriores sin secreto conservado no reciben enlaces nuevos ni se rotan automáticamente.

El correo se encola si el cliente lo aportó, aunque el proveedor no esté configurado. Contiene nombre, restaurante, local, dirección y teléfono disponibles, referencia, hora en la zona del local, total en céntimos formateado y enlace privado original. `PUBLIC_APP_URL` establece el origen (en el emulador del agente 5, `http://localhost:3015`; fuera de local, valor por defecto `https://llenamos.logiqd.me`). Las credenciales existentes de correo son `RESEND_API_KEY` y `EMAIL_FROM`. El procesador existente conserva `queued`, `sent`, `captured`, `not_configured` o `failed`, intentos y último error; un fallo del proveedor no revierte ni elimina el pedido. No se introduce reintento infinito. El personal ve los mensajes en la bandeja existente y `verParaLlevarPublico` añade `notifications? [{channel,template,status}]`, sin destinatarios, errores internos ni secretos. El seguimiento distingue modo local de entrega real.

WhatsApp solo se encola si están configurados `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` y la plantilla aprobada del evento (`WHATSAPP_TEMPLATE_TAKEAWAY_ACCEPTED` o `WHATSAPP_TEMPLATE_TAKEAWAY_READY`). Se usa `type: template`, nunca texto libre para iniciar estos avisos. Cada plantilla debe tener seis variables de cuerpo, en este orden: nombre del cliente, restaurante, referencia, fecha y hora, total, enlace completo. Debe estar aprobada en los idiomas ofrecidos (`es`, `ca`, `en_GB`). Sin esa configuración no se encola WhatsApp ni se anuncia un envío. Los proveedores se verifican con respuestas controladas en pruebas, sin solicitudes reales a Resend o Meta.

### Callables (contrato para el backend)

Se registran en `api.ts` mediante `CALLABLES_FASE2` y `CALLABLE_SCHEMAS_FASE2` de `api-sala.ts`; `CallableInput` y `CallableOutput` funcionan también con ellas. Entradas superiores y líneas estrictas; las fichas anidadas se validan y eliminan campos ajenos antes de guardar. Salidas abiertas a ampliaciones. Errores de autenticación, acceso, destino obsoleto o transición usan `HttpsError` estándar con mensaje en castellano. Problemas de carta devuelven `rejected` sin escribir el pedido.

En la tabla, **S** = `{ restaurantId, locationId }`, **T** = `{ slug, locationId, tableId, token }`, **L** = `OrderLineInput[]` (plato con `itemId, variantId?, optionIds?, quantity, notes?, guest?, course?`; menú con `dailyMenuId, quantity, notes?, guest?, selections[{ sectionId, itemId, variantId?, optionIds?, notes? }]`), **LP** = lo mismo sin `course`. **R** = `{ status: "rejected", problems[{ line|null, selection|null, code, ref|null }], totalCents }`. Los instantes de salida son ms. `reason?`, `note?` y los demás opcionales siguen exactamente los esquemas exportados; `website?` debe ir vacío. `expectedTotalCents` detecta un precio cambiado, nunca lo impone. Un id de catálogo nulo crea una ficha nueva. `ok` significa `{ ok: true }`.

| Nombre | Entrada | Salida | Quién / permiso | Módulo base |
|---|---|---|---|---|
| `guardarCategoriaCarta` | S, `categoryId|null, category: MenuCategory` | ok, `categoryId` | carta.editar | floor |
| `guardarPlato` | S, `itemId|null, item: MenuItemEditable` | ok, `itemId, version, priceChanged` | carta.editar | floor |
| `guardarMenuDia` | S, `dailyMenuId|null, menu: DailyMenuEditable` | ok, `dailyMenuId, version, priceChanged` | carta.editar | floor |
| `ordenarCarta` | S, `categories? [{id,sortOrder}], items? [{id,categoryId,sortOrder}]` | ok | carta.editar | floor |
| `marcarAgotado` | S, `itemId, optionId?, variantId?` (ambos ausentes o nulos = plato; no pueden coexistir), `soldOut` | ok, `soldOut` | carta.agotar; estación propia en cocina/barra | floor |
| `guardarEstacion` | S, `stationId|null, station: Station` | ok, `stationId` | sala.configurar | kitchen |
| `guardarConfiguracionSala` | S, `settings: FloorSettings` | ok | sala.configurar | floor |
| `regenerarQrMesa` | S, `tableIds[]` | `tokens [{tableId,token,path}]` | sala.configurar | floor |
| `recuperarQrMesa` | S, `tableIds[]` | `tokens [{tableId,token,path}], unavailable [{tableId,reason: missing|revoked|legacy}]` | sala.configurar | floor |
| `importarQrMesa` | S, `tableId, token` del enlace original | `tokens [{tableId,token,path}]` | sala.configurar | floor |
| `revocarQrMesa` | S, `tableIds[]` | ok | sala.configurar | floor |
| `abrirMesa` | S, `tableIds[], guests, reservationId?, guest? {name,phone}, waiterUid?, notes?` | `sessionId, label, joinable, reservationSeated` | sala.gestionar; reservas.gestionar si hay reserva | floor |
| `cambiarEstadoMesa` | S, `sessionId, status` (excepto merged), `reason?` | ok, `status, totalCents` | sala.gestionar | floor |
| `editarMesa` | S, `sessionId, guests?, waiterUid?, notes?` (algún cambio) | ok | sala.gestionar | floor |
| `moverMesa` | S, `sessionId, tableIds[]` | ok, `tableIds[], label` | sala.gestionar | floor |
| `juntarMesas` | S, `sessionId` destino, `tableIds[]` | ok, `tableIds[], label, mergedSessionIds[], joinable` | sala.gestionar | floor |
| `separarMesas` | S, `sessionId, tableIds[], lineIds?, guests?` | ok, `newSessionId|null, keepTableIds[], splitTableIds[]` | sala.gestionar | floor |
| `enviarPedido` | S, `sessionId?` o `takeawayId?`, `lines: L, fire?, note?, expectedTotalCents?` | `status: "sent", orderId, lineIds[], totalCents, sessionTotalCents, fired, held` o R | comandas.tomar | floor |
| `decidirPedido` | S, `orderId, decision: "accept"|"reject", reason?, fire?` | ok, `status, fired, held` | comandas.tomar | floor |
| `marcharPase` | S, `sessionId?` o `takeawayId?`, `course?` (pase, all o nulo) | ok, `course|null, lineIds[]` | comandas.tomar | floor |
| `cambiarEstadoLineas` | S, `lineIds[], status` (excepto pending), `reason?` | ok, `lines [{id,status}], firedNext[]` | por cada línea y transición; todo o nada | floor |
| `crearTarea` | S, `sessionId?, tableIds?, note, claim?` | `taskId` | tareas.atender | floor |
| `cambiarEstadoTarea` | S, `taskId, action: "claim"|"release"|"done"|"cancel"` | `result: "ok", status, claimedBy|null, claimedByName|null` o `result: "taken", claimedBy, claimedByName|null` | tareas.atender | floor |
| `verMesaPublica` | T | `restaurantName, locationName, tableName, publicMenuId, canOrder, requireApproval, callWaiter, requestBill, session|null` | público, token válido | floor |
| `pedirDesdeMesa` | T, `sessionId, lines: LP, expectedTotalCents, language, note?, website?` | `status: "sent"|"pending_approval", orderId, totalCents` o R | público, token y sesión vinculados | floor |
| `avisarDesdeMesa` | T, `sessionId?, kind: "call_waiter"|"request_bill", website?` | ok, `taskId` | público, token válido; cuenta exige sesión | floor |
| `consultarRecogida` | `slug, locationId, date` | `date, timezone, enabled, slots [{time,wallDate,startAt,shift,available,reason|null}]` | público | floor |
| `pedirParaLlevar` | `slug, locationId, date, time, guestName, phone, email?, language, lines: LP, expectedTotalCents, notes?, acceptPolicy: true, website?` | `status: "pending"|"accepted", reference, manageToken, pickupAt, totalCents` o R | público; para llevar público activado | floor |
| `verParaLlevarPublico` | `slug, reference, token` | `reference, status, guestName, pickupAt, timezone, locationName, totalCents, lines[]` | público con token de seguimiento | floor |
| `crearParaLlevar` | S, `date, time, guestName, phone, email?, language?, source: "phone"|"walk_in", lines: L, notes?, fire?` | `status: "accepted", takeawayId, orderId, reference, manageToken, pickupAt, totalCents` o R | comandas.tomar | floor |
| `cambiarEstadoParaLlevar` | S, `takeawayId, status` (excepto pending), `reason?` | ok, `status` | comandas.tomar | floor |

`verMesaPublica.session` contiene únicamente `{ sessionId, status, guests, totalCents, lines[] }`. Las líneas públicas (`PublicOrderLineSchema`) muestran `id, kind, name, variant|null, modifiers[], components[], quantity, totalCents, status`; componentes solo nombres, variante, extras y estado. El total de un menú público reúne padre y componentes. Estados públicos: `pending`, `in_kitchen`, `on_its_way`, `served`, `cancelled`, mediante `publicLineStatus`. Nunca se devuelven teléfonos de la reserva, cliente, notas privadas, hashes, responsables o detalles internos de estaciones. Cocina/barra leen notas de la línea, no el documento de cliente.

### Transacciones, reservas, mesas y gasto

Las comprobaciones y escrituras sensibles ocurren en una transacción: disponibilidad de mesas, estado anterior, pertenencia al local, precio y versión de carta, destino, capacidad de recogida, dueño de tarea, índices y actividad. Para ocupación se reutiliza **el mismo** `reservationLocks/current` de fase 1, también al abrir, mover, juntar, separar y cerrar sesiones; no se crea un segundo bloqueo independiente para sala. Para recogida se usa un documento `serviceLocks` por franja UTC. No basta una consulta de sesiones vacías para garantizar que dos aperturas concurrentes no ocupen la misma mesa. Nunca se publica la proyección pública dentro de una transacción que aún pueda fallar.

Sentar una reserva mediante `cambiarEstadoReserva` con `floor` activo abre la sesión **en esa misma transacción**, usando `sessionFromReservation`, y devuelve la reserva sentada como hasta ahora; la web encuentra la sesión escuchando Firestore. `abrirMesa(reservationId)` reutiliza el mismo procedimiento. Usa un índice privado determinista por reserva para que una repetición encuentre la sesión y no cree otra; una reserva ya cerrada no se vuelve a sentar. Reserva y sesión deben estar en el mismo local, con mesas habilitadas. Sin `floor`, sentar sigue funcionando como en fase 1. Sin mesas asignadas, se rechaza sentar con `floor` y se pide asignarlas primero.

Para disponibilidad se usa `sessionToOcupacion` para **todas** las sesiones abiertas, con duración de grupo de los ajustes de reservas, y se excluyen las reservas sentadas que esas sesiones ya representan, incluidas las fuentes absorbidas por una unión. Así no se duplica capacidad y una mesa movida, dividida o reabierta ocupa sus mesas actuales. Las reservas futuras siguen comprobándose; abrir, mover o juntar rechaza solapes previstos con ellas. No se modifica `joinableWith` ni el plano al mover el servicio. `planOpen`, `planMove`, `planJoin` y `planSplit` resuelven la parte pura; el servidor añade las comprobaciones de reservas, comensales y concurrencia. `joinable: false` permite la operación del personal con aviso visible; nunca abre una mesa ocupada por otra sesión salvo una unión explícita.

Juntar añade mesas libres o absorbe **la sesión entera** que ocupe una mesa elegida. Conserva la sesión destino, suma comensales sin superar 200 ni ocho mesas, marca fuentes `merged` con `mergedInto` y mueve el destino actual de todas sus líneas y tareas. Las fuentes conservan reserva, cliente e historial como trazabilidad. La decisión operativa de esta fase es que el **cliente de la sesión destino recibe el gasto conjunto**; la interfaz lo explica antes de juntar grupos con distinto cliente. Al terminar se finalizan también las reservas de las fuentes absorbidas. No se reparte automáticamente gasto entre clientes.

Separar siempre deja alguna mesa en la sesión original. Sin líneas libera las mesas elegidas; con líneas abre otra sesión y mueve esos platos, con todos los componentes cuando sea un menú. No admite mover un componente suelto, pedidos aún por aprobar ni líneas de otra sesión. La nueva sesión conserva el cliente para atribuir su gasto, `reservationId: null` para no duplicar visitas y exige `guests` entre 1 y el total menos uno, descontándolos de la original. Las reservas representadas mantienen su trazabilidad; no se crea una segunda reserva. Al mover, juntar o separar se actualizan etiquetas y tareas y se recalculan ambos totales en la misma operación. Una comanda separada aparece en cocina en tickets distintos por `(orderId, sessionId, takeawayId)`; la clave de React tampoco puede ser solo `orderId`.

Cerrar exige nada pendiente de aprobación y todos los platos servidos o anulados (`checkCloseSession`). Libera las mesas, cancela tareas activas del destino y termina la reserva si estaba sentada. Cancelar una apertura por error exige no tener líneas vivas (`checkCancelSession`). Reabrir exige mesas libres, sin conflicto de reservas; solo reabre la sesión y no revierte una reserva `finished` ni suma otra visita. El gasto de fase 2 es **consumo registrado**, no dinero cobrado. `customers.spentCents` suma sesiones cerradas y para llevar recogidos. Una aportación por destino (`spendContributions`) guarda cliente e importe ya contabilizados: cada cierre/recogida, corrección o reapertura aplica solo la diferencia anterior/nueva en transacción, y reabrir retira la aportación. Así ni reintentos ni entregas repetidas de eventos duplican gasto. El padre y los suplementos se cuentan una sola vez. No cambia el número de visitas de reservas por abrir una mesa sin reserva.

### Estados y pases

| Entidad | Desde | Puede pasar a |
|---|---|---|
| Comanda | pending_approval | accepted, rejected |
| Comanda | accepted, rejected | final; el progreso va por sus líneas |
| Línea | pending | held, fired, cancelled (solo decisión de comanda) |
| Línea | held | fired, cancelled |
| Línea | fired | held, preparing, ready, served, cancelled |
| Línea | preparing | fired, ready, served, cancelled |
| Línea | ready | preparing, served, cancelled |
| Línea | served | ready, cancelled |
| Línea | cancelled | final |
| Mesa abierta | open | bill_requested, closed, merged, cancelled |
| Mesa abierta | bill_requested | open, closed, merged, cancelled |
| Mesa abierta | closed | open (solo si las mesas siguen libres) |
| Mesa abierta | merged, cancelled | final |
| Tarea | open | claimed, done, cancelled |
| Tarea | claimed | open, done, cancelled |
| Tarea | done, cancelled | final |
| Para llevar | pending | accepted, cancelled |
| Para llevar | accepted | ready, cancelled |
| Para llevar | ready | picked_up, accepted, cancelled |
| Para llevar | picked_up, cancelled | final |

Las tablas están en `SESSION_TRANSITIONS`, `ORDER_TRANSITIONS`, `LINE_TRANSITIONS`, `TASK_TRANSITIONS`, `TAKEAWAY_TRANSITIONS`. `checkLineTransition` combina transición, permiso y motivo; `applyLineStatus` guarda historial y horas y borra las horas posteriores al deshacer. Volver a empezar conserva el instante original de marcha, salvo que se desmarque primero. La callable ignora una línea que ya tiene el estado pedido; el resto es todo o nada. No permite editar una sesión cerrada ni servir/anular líneas de un destino cerrado: primero se reabre. El estado del padre de un menú es derivado, sin acciones directas. Un rechazo de comanda anula sus líneas pendientes y termina la tarea de aprobación en la misma transacción; el motivo de rechazo es obligatorio aunque el esquema admita omitirlo para una aceptación.

Pases en orden: `drinks`, `first`, `second`, `dessert`. `firingFor` manda bebidas al momento y, en `auto/by_course`, el primer pase de comida sin anteriores pendientes; los demás quedan `held`. `fire: "all"` o `auto/all_at_once` marcha todo; `hold` retiene comida, no bebidas. Los pedidos QR usan siempre `fire: "all"`: salen completos, sin separar pases, al aceptarse o al enviarse si no requieren aprobación. `decidirPedido` fuerza esa misma política para pedidos `source: "table"`, también los antiguos pendientes, conservando precios y notas. Los pases del personal mantienen las reglas anteriores. `marcharPase` marcha el pase elegido, el siguiente retenido si es nulo, o todos con `all`; no acepta ni modifica líneas pendientes. `autoFireAfterServe` solo marcha el siguiente pase si está activado y no queda comida pendiente, marchada, preparándose o lista. Un pedido nuevo estando `bill_requested` vuelve a `open` y cancela la tarea de cuenta vigente.

Empezar, terminar o deshacer preparación requiere permiso de la estación; marchar/desmarchar requiere sala; servir o deshacer servido admite sala o estación propia. Anular desde `pending/held` requiere `comandas.tomar`; desde `fired/preparing/ready/served`, `comandas.anular` y motivo no vacío. Ningún rol de estación puede marchar, aceptar, cambiar precios o anular una comanda. Sin estación lo prepara y sirve la sala. `resolveStation` busca la estación activa del plato y después la activa por defecto; si ninguna existe queda sin estación, visible en el comandero. Tiempo objetivo: plato, estación o valor por defecto, por ese orden.

«Voy yo» usa `claimTask` dentro de una transacción. Si otra persona la cogió devuelve `taken` y su nombre; cogerla de nuevo uno mismo es idempotente. `releaseTask` deja soltarla al dueño y permite intervención de owner/manager (no basta `sala.gestionar`, que también tiene el camarero). `completeTask` permite a cualquier persona con `tareas.atender` resolverla, dejando `doneBy`; `cancelTask`, anularla. Completar una recogida sirve las líneas referidas que siguen listas; no fuerza las que volvieron a preparación. Completar una aprobación exige decidir antes el pedido; una tarea no acepta pedidos por sí sola. Completar cuenta solo significa que el personal atendió la petición, no que se pagó.

### QR, recogida y exposición pública

`regenerarQrMesa` genera 32 bytes aleatorios por mesa con `linkToken`, guarda `sha256Hex(token)` y el secreto privado en `tableTokens/{tableId}` y devuelve el token y `tableQrPath`. Ruta: `/m/{slug}/{locationId}/{tableId}?t=...`; NFC contiene la misma URL. Regenerarlo invalida el anterior. Cada callable resuelve slug a restaurante y compara el hash **en esa ruta exacta**; otro `tableId`, local o restaurante no sirve. La mesa debe existir y estar habilitada. Para pedir valida en la misma transacción que `sessionId` está abierta y contiene esa mesa; el cliente no elige un destino libremente. Un enlace anterior a un movimiento debe volver a consultar; nunca se redirige un pedido silenciosamente a otra sesión. Llamar sin sesión usa una tarea por mesa; pedir cuenta exige sesión vigente y cambia a `bill_requested`.

La carta se escucha por Firestore público. La sesión pública y el seguimiento para llevar se consultan por callable, sin listeners directos a documentos privados. `canOrder` exige sesión vigente, `floor` y `selfOrder.enabled`. `requireApproval` crea comanda pendiente, líneas `pending` invisibles a cocina y tarea `approve_order`; si está apagado entra aceptada. Los QR son credenciales de esa mesa reutilizables hasta rotarlos; no prueban presencia física. Se aplica limitación de solicitudes por IP y token con contadores privados, además del campo trampa. No se escriben tokens completos en actividad ni registros de errores.

`pickupSlots` usa semana, excepciones y cierres de reservas, con el paso y antelación de para llevar; cuentan pedidos `pending`, `accepted`, `ready` y `picked_up`, nunca cancelados. El público respeta `maxAdvanceDays` del local además de la antelación y límite por franja. El personal puede saltarse antelación y capacidad, pero no elegir una hora pasada ni fuera de turno. Se revalida la franja dentro de la transacción. Si no está habilitado, `consultarRecogida` devuelve `enabled: false, slots: []`. `crearParaLlevar` entra aceptado; el público sigue `autoAccept`. `takeawayFiring` deja líneas aceptadas retenidas hasta `pickupAt − prepLeadMinutes`, sin separar pases; `all` permite adelantarlas y `hold` las retiene hasta esa hora o una marcha manual. Un procesador no marcha líneas `pending`. `takeawayStatusFromLines` pone `ready` cuando todo lo vivo está listo o servido y vuelve a `accepted` si se deshace; `picked_up` exige todo listo y sirve lo restante en la misma operación. Cancelar exige motivo, anula líneas con la autorización correspondiente y cancela tareas; si no queda ninguna línea viva, se cancela el pedido, no se queda esperando indefinidamente.

### Disparadores y procesos previstos

El backend es dueño de estos procesos y sus pruebas. Los invariantes de servicio y totales se resuelven en la callable, para que cerrar o pedir cuenta lea datos consistentes; un disparador no sustituye esa transacción.

| Proceso | Cuándo | Qué hace y cómo evita duplicados |
|---|---|---|
| `cartaPublica` | categorías, platos, menús, settings/floor, local o marca/módulos del restaurante cambian | reconstruye `buildPublicMenu` desde el estado actual, con bloqueo de publicación por local para no sobrescribir con una versión vieja; borrado de local/restaurante elimina proyección |
| Actividad de sala | decisiones confirmadas de carta, estación, QR, mesa, pedido, línea, tarea y para llevar | la callable escribe actividad con actor y `changeId` en su transacción; disparador omite lo ya registrado, como fase 1. Acciones `menu.itemSaved`, `menu.soldOutChanged`, `floor.settingsChanged`, `tableSession.opened/moved/merged/split/statusChanged`, `order.placed/decided`, `orderLine.statusChanged`, `floorTask.claimed/completed`, `takeaway.created/statusChanged`; nunca tokens ni datos privados en el resumen |
| Recogidas en el pase | líneas pasan a ready o vuelven atrás | el ayudante transaccional común a cambios de línea crea/amplía tarea pickup con `readyForPickup` si `station.pickup`; al servir/anular retira líneas y termina tareas vacías. Un disparador de reconciliación recalcula desde documentos actuales e índices de tarea, sin recrear tareas cerradas de un estado antiguo |
| Gasto del cliente | cierre/reapertura/corrección de mesa, recogida/corrección de para llevar | callable aplica diferencia mediante `spendContributions`; reconciliación puede repetir sin sumar de nuevo. Finalizar visitas sigue perteneciendo a la fase 1 y no lo duplica este proceso |
| `marcharParaLlevar` | cada minuto y ejecución local explícita | transacción por destino, busca `dueTakeawayLines`, comprueba estado aceptado y módulos, marcha una vez y actualiza padres. El planificador no corre en emuladores: backend añade script local propio que invoca el mismo procesador, sin callable pública administrativa |

`delayFor` marca `at_risk` al llegar al 75 % y `late` al llegar a `dueAt`. Preparación cuenta desde `firedAt`, no desde `startedAt`; una línea lista cuenta desde `readyAt` con `pickupMinutes`. Las tareas cuentan desde `openedAt` hasta `dueAt`, también cogidas. Retenidas, pendientes, servidas y anuladas no tienen reloj de preparación. `stationTickets` agrupa por estación, comanda **y destino**, y `worstDelay` resume el peor retraso. `lateAlerts` avisa solo al cruzar el límite entre `lastCheckAt` y `now`: la pantalla conserva su último control mientras está activa y no vibra por cada plato nuevo ni al entrar con retrasos antiguos. El aviso de recogida lo representa la tarea; no se duplica vibración por esa tarea y por sus líneas. Los avisos locales de tareas omiten las cogidas y cerradas. Web Push en segundo plano se define debajo; no se garantiza exactamente una vibración entre varios dispositivos.

### Cierre de cocina: tickets, marcha, raciones y avisos

Cambios de contrato aditivos del cierre `fase2/completar-cocina`:

1. **`OrderLine.ticket?`**: instantánea operativa `{ reference, source, note, pickupAt|null, pickupReference|null, guestName|null }`. `reference` son los seis primeros caracteres del id del pedido en mayúsculas; el servidor evita colisiones al generar ids dentro del local. Es común a todas sus estaciones y se conserva al mover o dividir mesas. `note` combina la nota del envío (máximo 200) y las instrucciones de recogida (máximo 1000), sin duplicarlas, con un máximo de 1201 caracteres. No incluye teléfono, correo ni notas privadas de reserva o cliente. `pickupAt` es `Timestamp` al guardar y ms al leer. La reconciliación completa tickets antiguos que carezcan del campo. `StationTicket.ticket?` conserva estos datos. Cocina y barra siguen leyendo únicamente sus líneas: no se amplían permisos de documentos de pedido ni de contacto.
2. **Marcha QR**: sale todo al aceptarse, como se detalla arriba. La pantalla de estación lo explica. `publicLineStatus("held")` devuelve el nuevo estado público `"held"`, traducido «espera a sala», en vez de afirmar que se está cocinando. Se aplica también a componentes de menú y recogidas programadas.
3. **`FloorTask.purpose?: "fire_course"`**: tarea de tipo `custom` por sesión con comida retenida. La transacción la crea o actualiza, conserva dueño y vencimiento, y la cierra cuando ya no quedan platos retenidos. Puede cogerse, pero no completarse ni anularse hasta marchar o anular esos platos. Pedir cuenta y aprobar otro pedido conservan esta tarea; no dejan pases sin seguimiento. Tras mover, juntar o separar, la reconciliación asegura una tarea por destino vivo. La tarea empieza sin dueño para que sala la reclame, y puede generar un aviso si vence.
4. **`MenuItem.portions?`**: ausente o nulo significa sin contador. Si existe, `{ date: "AAAA-MM-DD", remaining: number|null, variants: Record<variantId,number> }`, solo servidor. `remaining` limita el total de unidades del plato, incluidas todas sus variantes; los contadores de variante añaden un límite independiente. Se suma todo el pedido, incluidos repetidos y componentes de menú multiplicados por su cantidad, y se descuenta dentro de la misma transacción que crea las líneas. Los pendientes de aprobación reservan ya las raciones. Si falta una, se rechaza el pedido entero sin descontar ninguno de sus platos. Al llegar a cero el total se marca `soldOut: true` y se publica; cero en una variante impide vender esa variante sin bloquear las demás. Precio y versión no cambian.

   La fecha es el día del **envío** en la zona del local, también en recogidas futuras. No hay reposición automática de madrugada. Un contador de otro día bloquea la venta hasta contar hoy. El primer recuento del día deja a cero los demás contadores que tenían un límite, hasta recontarlos o quitar su límite. Anular o rechazar **no devuelve raciones**: quien controla disponibilidad debe revisar físicamente y guardar un nuevo recuento absoluto. Campo vacío elimina ese límite; sin ningún límite se guarda `portions: null`. Volver a ofrecer un plato con total cero o recuento caducado exige recontar primero. El mismo permiso `carta.agotar` y la misma restricción de estación permiten editar estos datos.
5. **Tres callables nuevas**, registradas en `CALLABLE_SCHEMAS_FASE2` y exportadas desde functions:

   | Callable | Entrada | Salida | Permiso y módulo |
   |---|---|---|---|
   | `guardarRaciones` | S, `itemId, variantId?: string|null, remaining: number|null` (0 a 9999) | `{ ok: true }` | `carta.agotar`, `floor`; estación propia y `kitchen` para cocina/barra |
   | `configuracionPush` | S | `{ configured, publicKey|null, localCapture, subscribedEndpoints[] }` (solo propios) | `tareas.atender`, `floor` |
   | `guardarSuscripcionPush` | S, `enabled, subscription { endpoint, keys { p256dh, auth } }` | `{ ok: true }` | `tareas.atender`, `floor`; uid de Auth, máximo diez dispositivos activos por persona/local |

6. **Rutas privadas nuevas** bajo el local, sin lectura ni escritura de cliente: `pushSubscriptions/{sha256(endpoint)}` guarda uid, endpoint, claves de la suscripción, clave pública VAPID vigente y enabled; `pushDeliveries/{sha256([taskId,dueAt,subscriptionId])}` guarda tarea, suscripción, estado, intentos, lease y próxima fecha de intento. El historial de actividad solo describe alta/baja de suscripción o recuento; no escribe endpoints ni claves en el resumen. Las reglas existentes ya deniegan estas rutas. No se modifican reglas.
7. **`avisosRetrasados`** corre cada minuto y comparte `processPush` con `scripts/procesar-avisos.ts`. Solo considera tareas abiertas, vencidas y sin dueño. Revalida miembro activo, acceso al local, permiso, módulo, suscripción y estado antes de enviar. Deduplica por tarea, vencimiento y dispositivo; reclama con lease, reintenta fallos hasta tres veces con al menos un minuto entre intentos y desactiva endpoints HTTP 404/410. Coger o cerrar la tarea impide envíos posteriores. Una petición ya en tránsito puede llegar; el panel cierra notificaciones visibles al observar reclamación/cierre. TTL 60 segundos y etiqueta de tarea reducen avisos atrasados y vibraciones repetidas.
8. **Web Push estándar**, sin dependencias: `node:crypto`, cifrado aes128gcm de RFC 8291 y firma VAPID ES256 de RFC 8292. Variables solo de servidor `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (mailto o HTTPS). Sin par válido y contacto no se permite activar ni se envía nada; la interfaz lo dice. Solo endpoints HTTPS de los servicios de Firefox, Chromium y Apple, sin redirecciones. `sw-avisos.js` muestra el aviso con enlace a `/panel/avisos?task=...&restaurant=...&local=...`, que consulta el estado vigente y permite «Voy yo»; enfoca una ventana de panel o abre una nueva. El manifiesto permite instalar el panel. El permiso se solicita mediante un botón; iPhone requiere añadir a inicio y navegador compatible. El trabajador no guarda páginas ni datos del servicio en caché.

   **Local:** `FIRESTORE_EMULATOR_HOST` activa siempre captura, nunca tráfico hacia servicios push. La interfaz prueba permiso y registro del trabajador, y explica que no establece una suscripción real al proveedor. `node scripts/generar-vapid.mjs > functions/.env.local` genera claves de prueba usando únicamente `node:crypto`; reiniciar emuladores y exportar esas variables al ejecutar el procesador local. La clave privada nunca usa `NEXT_PUBLIC_`. Si cambia la clave pública, activar avisos renueva la suscripción del navegador antes de guardarla. Las pruebas criptográficas usan transporte interceptado y descifrado del receptor; los envíos locales quedan como `captured`, nunca `sent`. `scripts/e2e-avisos-local.cjs` prueba con Chromium real permiso, registro, evento push sintético por CDP, enlace a tarea y cierre de la notificación al reclamarla; no representa entrega por un proveedor ni pantalla bloqueada.

Las acciones de ticket de cocina usan `cambiarEstadoLineas`, sin callable nueva: se seleccionan solo líneas marchadas/en preparación de esa estación y la transacción valida todo el conjunto antes de cambiar nada. «Empezar» actúa sobre marchadas; «Dejar listos» sobre marchadas/en preparación. La impresión crea un documento claro con el ticket visible y abre el diálogo del navegador. No es ticket fiscal ni integración térmica de fase 3. La rejilla de estación adapta columnas desde 310 px, con platos de 24 px y botones de 48 px; cocina y barra usan el ancho de servicio de 1600 px.

**Evidencia y límites:** `docs/diseno/capturas/completar-cocina/README.md` describe navegador, puertos, recorridos, capturas a 2x y comprobaciones. No se ha probado entrega Web Push con un Android/iPhone real bloqueado, alta de proveedor real ni impresora física. Esto queda pendiente antes de prometer avisos móviles en producción.

### Reglas de Firestore, Storage y consultas

Se conservan las reglas de fase 1 para sus rutas. Cada regla nueva exige pertenencia activa y acceso al local, además de módulo y rol. Owner/manager tampoco saltan módulos. Todos los documentos nuevos e índices privados rechazan escrituras de cliente; las escrituras del plano y ajustes antiguos siguen exigiendo `updatedBy == request.auth.uid`.

| Ruta | Lectura del personal | Público | Escritura cliente |
|---|---|---|---|
| menuCategories, menuItems, dailyMenus | owner/manager/waiter con floor; kitchen/bar con floor y kitchen, para ver su carta y agotados | no | nunca |
| settings/floor | owner/manager/waiter con floor; kitchen/bar con floor y kitchen para tiempos | no | nunca |
| stations | owner/manager con kitchen; waiter con floor y kitchen; kitchen/bar con floor y kitchen | no | nunca |
| tableSessions, orders, takeaways | owner/manager/waiter con floor | solo salidas de callables con token | nunca |
| orderLines | sala con floor; estación con floor y kitchen, `stationKind` de su rol y status held/fired/preparing/ready/served/cancelled | solo salida filtrada de callables | nunca |
| floorTasks | owner/manager/waiter con floor | nunca lectura directa | nunca |
| tableTokens, serviceLocks, reservationSessions, taskKeys, spendContributions, takeawayReferences y contadores privados | nadie desde SDK cliente | nadie | nunca |
| publicMenus | cualquiera, get del documento conocido | sí, get; no listado global | nunca |
| customers.spentCents | mismos lectores que la ficha de cliente de fase 1 | no | nunca se puede cambiar, tampoco desde edición de notas |

Firestore no filtra resultados: cocina consulta por `stationId`, `stationKind` y los estados permitidos (excluyendo pending); barra hace lo mismo para bar. Las reglas deben comprobar las condiciones sobre cada documento. Las líneas de menú sin estación no aparecen en esa consulta. Por local, hacen falta índices para líneas por estación/tipo/estado y hora, líneas por destino/estado, sesiones por estado y mesa, tareas por estado/destino, recogidas por fecha/estado y reservas asociadas a sesiones. El backend añade solo los índices que exijan sus consultas reales y pruebas positivas y negativas por rol, módulo y local.

Fotos en `restaurants/{rid}/locations/{lid}/menu/{itemId}/{file}`: lectura pública solo del archivo cuyo nombre coincide con `photoPath` de ese `menuItems/{itemId}` activo, comprobado desde Storage con una lectura interna de Firestore; subida/borrado solo owner/manager con floor, miembro activo y local permitido. Máximo 5 MiB, `image/jpeg`, `image/png` o `image/webp`; SVG y rutas de otros platos/locales se rechazan. El servidor valida que `photoPath` pertenezca al restaurante, local y plato que guarda; la expresión del esquema por sí sola no comprueba propiedad. El editor primero guarda el plato nuevo para obtener id, luego sube la imagen y guarda su ruta. Se usa una URL de Storage autorizada por reglas, sin convertir fotos privadas en enlaces permanentes por token de descarga. Storage y su validación se prueban al implementar el backend; aquí solo se fija el contrato.

### Implementación del backend

Código en `functions/src/fase4/` (`index.ts` registra las 31 callables y los tres procesos; `functions/src/index.ts` los exporta), reglas en `firebase/firestore.rules`, índices en `firebase/firestore.indexes.json` y seed en `scripts/seed-fase4.ts`. **Core no ha cambiado**: se cumple el contrato tal cual y lo que sigue son decisiones de detalle que el contrato dejaba abiertas.

- **Una callable, una transacción.** `execute(name, data, request, { now? })` abre el contexto (restaurante, local, miembro, permiso y módulos de `FASE4_ACCESS`), lee todo lo que necesita, calcula con core y confirma al final una cola de escrituras más la actividad. `now` solo existe para las pruebas (reloj simulado del servidor); la callable nunca lo recibe. Las lecturas (`informeHoras`, `horasParaPropinas`, `sugerirPedidos`, `margenPlatos`) van en transacción de solo lectura y sin `requestId`.
- **Idempotencia.** Clave `sha256([uid, callable, requestId])` en `staffRequests` (personal) o `inventoryRequests` (el resto), con la huella de la entrada y el resultado. Misma clave y misma entrada: devuelve el resultado original sin repetir efectos; otra entrada: `already-exists`. Un fallo no guarda la clave.
- **Fichaje.** `staffClockLocks/{uid}` (nivel restaurante) se escribe y borra con el fichaje; un bloqueo que apunta a un fichaje ya cerrado se ignora y se sustituye. Fichar abierto en otro local da `failed-precondition`. Un fichaje abierto que supera `forgottenAfterMinutes` cuenta como olvidado **al instante** para fichar y para `horasParaPropinas`, sin esperar al proceso (que solo pone la marca y avisa). `cerrarFichajeOlvidado` vale para cualquier fichaje abierto, no solo los marcados. Las horas que escribe un encargado se truncan al minuto y deben ser posteriores a la entrada.
- **Puesto de fichaje.** Los intentos fallidos de PIN **se guardan aunque la llamada falle** (la operación confirma el contador y después lanza el error). Error `permission-denied` con `details: { reason: "wrong" | "locked", attemptsLeft, lockedUntil }`. El PIN nunca se guarda en claro ni sale en actividad. Quitar el PIN (`pin: null`) borra su documento.
- **Cuadrante.** Un turno nuevo nace en borrador aunque su semana esté publicada; al editar conserva su estado si no cambia de semana. `guardarTurno` lee unos 8 días alrededor para solapes (rechazo), descansos y horas de su semana (avisos). `copiarSemanaCuadrante` salta con motivo los turnos que se pisan con otros de la semana de destino (repetir la copia no duplica) y los de una hora que no existe.
- **Existencias.** Todo cambio pasa por el libro `StockBook` (`almacen.ts`): movimiento inmutable, cantidad, valor, último coste y aviso en la misma transacción. Los movimientos manuales llevan el `requestId`. Una edición de ingrediente no mueve existencias ni sube la revisión por un movimiento; sí reevalúa el aviso si cambia el mínimo. Un ingrediente nuevo con mínimo y sin existencias nace con aviso «agotado». La unidad solo cambia mientras no haya movimientos.
- **Recuento.** `countedAt` es el instante del servidor al guardar una línea y no cambia si se vuelve a guardar la misma cantidad; el ajuste resta lo movido **estrictamente después** (`stockMovements.at > countedAt`). Al aplicar se guarda `result` en el documento del recuento (campo adicional no estricto) y aplicar de nuevo devuelve ese resultado.
- **Compras.** Un solo formato `preferred` por ingrediente (marcar uno desmarca los demás). Un formato no cambia de proveedor ni de ingrediente. Guardar de nuevo un borrador vuelve a tomar los precios actuales de los formatos y conserva el `lineId` (`l1`, `l2`…) de cada formato. El último precio pagado se compara con el de lista solo la primera vez. `recibirPedidoProveedor` actualiza `lastPriceCents` y `lastReceivedAt` del formato en la misma transacción.
- **Descuento al vender.** `consumirPorLinea` (`onDocumentWritten` sobre `orderLines`) ignora las escrituras que no cambian el estado y llama a `consumeLine`, que lee la línea y su `lineCosts` **en la transacción** y aplica los pasos de core. Se prueba contra el disparador real y contra la reconciliación. `lineCosts.at` es el instante en que marchó la línea (o `now` si faltara) y no cambia después: es la fecha con la que `margenPlatos` filtra. Una receta sin ingredientes ni coste manual se anota como `no_recipe`. Un ingrediente de la receta que ya no existe se omite y el coste queda `complete: false`.
- **Procesos.** `reconciliarConsumos` (cada hora, 48 h) y `revisarFichajesAbiertos` (cada 15 minutos) tienen su función pura exportada (`reconcileConsumption`, `reviewOpenEntries`) para probarla sin planificador.
- **Actividad** (solo la ve owner y manager): `staff.settings_saved`, `pin_saved`, `entry_created`, `entry_corrected`, `entry_closed`, `entry_voided`, `entry_forgotten`, `shift_saved`, `shift_deleted`, `schedule_published`, `schedule_copied`; `inventory.settings_saved`, `ingredient_saved`, `recipe_saved`; `stock.low`, `waste`, `adjusted`, `count_started`, `count_applied`, `count_cancelled`; `purchase.supplier_saved`, `item_saved`, `order_saved`, `sent`, `cancelled`, `closed`, `received`. Las llamadas repetidas no duplican actividad porque se escribe en la misma transacción.
- **Reglas e índices.** Las reglas son las de la tabla de arriba, con `staffManager`, `staffOn`, `inventoryReader` e `inventoryManager`, y ninguna escritura de cliente. `settings/staff` y `settings/inventory` se leen de uno en uno (listar `settings` no vale). Índices añadidos: fichajes por (uid, startAt), (uid, date), (status, date), (forgotten, date) y (date, startAt); turnos por (uid, startAt), (weekStart, startAt) y (status, weekStart, startAt); movimientos por ingrediente, línea, recuento o albarán y hora; `lineCosts` por (itemId, at); pedidos por (supplierId, status) y (status, revision); albaranes por (supplierId, receivedAt); formatos por (supplierId, name); recuentos por (status, startedAt).
- **Seed** (`pnpm exec tsx scripts/seed-fase4.ts`, tras `pnpm seed`, con `FIRESTORE_EMULATOR_HOST` y `FIREBASE_AUTH_EMULATOR_HOST`): enciende `staff` e `inventory` en Taberna Lumbre, activa el puesto de fichaje con PIN (Diego 1234, Lucía 2345, Pau 3456, Nora 4567), crea seis días de fichajes (con noches que cruzan la medianoche y pausas) y un fichaje olvidado de Lucía, el cuadrante de esta semana (publicado) y la siguiente (borrador), 22 ingredientes con existencias, 17 recetas de la carta demo, tres proveedores con 11 formatos, dos mermas, un pedido recibido en parte con subida de precio y otro en borrador. Deja avisos de stock bajo (aceite, bacon, salsa brava) y uno agotado (tarta). Es idempotente y los días nuevos se añaden al repetirlo.
- **Pruebas.** `functions/src/fase4/*.integration.test.ts` (emuladores: personal, inventario, compras, punta a punta y seed) y `tests/rules/fase4-firestore.test.ts`.

### Core entregado y límites de la fase

Todo está exportado desde `@llenamos/core`: `carta/` contiene modelos, versiones, i18n, demo, `priceOrder`, proyección pública y rutas; `sala/`, documentos, adaptadores `tableSessionForWrite`, `orderForWrite`, `orderLineForWrite`, `floorTaskForWrite`, `takeawayForWrite`, transiciones, planes de mesas, ocupación, totales, tareas y horas de recogida; `cocina/`, borradores, estaciones, pases, tickets y retrasos. Los esquemas de lectura aceptan los mismos Timestamp que fase 1. Quien llama una función pura primero valida la entrada zod y los documentos de carta. Un fallo de precio no se persiste parcialmente. No se aceptan importes de cliente como precio ni se consulta un proveedor real para calcularlos.

No se hace en fase 2: cobro, pago desde QR, devoluciones, dividir pagos, propinas, factura/ticket fiscal, Verifactu/TicketBAI, impresión térmica, caja, inventario de materias primas, entrega a domicilio, fidelización, traducción automática, copia de cartas entre locales, cola offline fiable. El contador sencillo de raciones y Web Push de retrasos sí se incluyen en el cierre de cocina descrito arriba. Pedir la cuenta genera una tarea y cerrar registra consumo; ninguna de esas acciones confirma un pago. La cola offline fiable sigue en fase 6. El comandero y el QR guardan ahora el borrador y la solicitud en vuelo en el navegador; recuperan una respuesta incierta reenviando exactamente la misma solicitud con su clave idempotente. No se activa nada en Firebase real ni se conecta Stripe.

Decisiones operativas fijadas para poder implementar: carta por local, aprobación QR encendida por defecto, precio congelado al enviar, gasto conjunto al cliente de la sesión destino, cierre sin cobro y horarios de recogida compartidos con reservas. No bloquean esta entrega. Antes de vender deben confirmarse con el usuario la atribución del gasto al juntar clientes distintos y si los horarios compartidos bastan para el servicio para llevar. Siguen pendientes los planes comerciales y demás decisiones generales de `PLAN.md`.

### Cierre de sala: borradores, idempotencia y política horaria

Cambios aditivos del contrato. No añaden dependencias, callables ni permisos y no permiten escrituras de cliente nuevas:

- `enviarPedido` y `pedirDesdeMesa` admiten `requestId?` (16 a 100 caracteres), `expectedDestination?` y `expectedPrices?`. El comandero de mesa y el QR actualizados los envían en cada pedido nuevo. Los clientes anteriores conservan su firma de entrada; sin `requestId` no tienen garantía de deduplicación. Una clave identifica un envío por restaurante, local y autor (uid en personal, hash del token en QR). `orderSubmissions/{sha256}` es una colección privada solo de servidor: guarda huella de la entrada y respuesta confirmada en la misma transacción que la comanda. Repetir clave y entrada devuelve esa respuesta sin volver a crear líneas, tareas o actividad, incluso tras mover o cerrar la sesión. Otra entrada con esa clave se rechaza. Se siguen validando permisos, módulo, local y, en QR, el token vigente antes de recuperar. Las respuestas `rejected` no consumen la clave. No se caducan estos registros durante fase 2.
- `expectedDestination` es JSON de `[sessionId, tableIds ordenados, openedAt en ms, customerId, guests, status]`. Se compara en el servidor antes de un envío nuevo. `verMesaPublica` entrega `destination?` con esa firma. Cualquier movimiento, cambio de comensales, cliente o estado exige revisión explícita del borrador. Un reintento confirmado recupera la respuesta original y no vuelve a validar el destino antiguo.
- `expectedPrices` se calcula con `orderPriceSignature(priceOrder(...).lines)`: versiones, precio unitario y componentes. Además del total, detecta cambios compensados entre platos. Una discrepancia devuelve `price_changed`, sin escritura parcial. El navegador exige revisar otra vez el total si cambian precios o versiones. Los importes definitivos siguen calculándose en el servidor.
- El comandero de mesa guarda líneas, nota general, salida de platos, destino revisado y solicitud en vuelo en `localStorage`, con clave por uid, restaurante, local y sesión. El QR hace lo mismo por navegador y enlace de mesa, incluyendo un hash del token, sin persistirlo en claro como parte de la clave. Un envío incierto bloquea editar o enviar otro contenido hasta recuperar su resultado. Solo una respuesta confirmada vacía el borrador. Es persistencia local, no sincronización entre dispositivos ni cola offline. La última ronda se reconstruye a partir de las elecciones originales y se vuelve a validar y calcular con la carta actual.
- `FloorSettings.allowOrdersOutsideHours?: boolean`: ausente o `true` permite a una mesa abierta pedir fuera de horario, conservando el comportamiento previo. `false` exige estar dentro de los turnos de reservas del local, con su zona horaria, excepciones y cierres. Se incluye el minuto de `lastEntry`, pero no los minutos posteriores; los turnos que cruzan medianoche pertenecen al día en que empiezan. Se valida en `enviarPedido` y `pedirDesdeMesa`; `verMesaPublica.canOrder` lo refleja. No impide recuperar un envío ya confirmado, leer la carta ni llamar. Los encargados lo configuran desde `/panel/comandas` mediante `guardarConfiguracionSala` y el permiso existente `sala.configurar`.
- `avisarDesdeMesa` admite `reason?` (`water`, `cutlery`, `napkins`, `order`, `other`) y `note` opcional, hasta 200 caracteres. `FloorTask.requests?` conserva hasta diez parejas distintas de motivo y nota, con preferencia por las últimas. Los avisos siguen agrupados en una tarea activa por destino; repetir aumenta `count` y conserva dueño, apertura y plazo. Completarla permite una llamada nueva.
- Al llegar más líneas listas a una recogida activa se actualizan `lineIds` y `count`, conservando dueño y plazo. La interfaz muestra cantidades, nombres, variantes, extras, notas y comensal sin abrir otro pedido y avisa de la ampliación. `cambiarEstadoTarea.expectedLineIds?` exige que al confirmar una recogida siga siendo la bandeja vista; una diferencia obliga a revisar. Sin este campo se conserva el comportamiento previo.
- El plano de Sala resume estados por mesa en este orden: llamada, listo para servir, pendiente de aprobación, cuenta pedida y preparando (incluye marchado). La ficha conserva todos los estados coincidentes y los minutos desde `openedAt`; la prioridad no oculta estados en el detalle. Las tareas usan `sortTasks`: vencidas primero, propias al principio dentro de cada grupo, después antigüedad.
- `/panel/comandas`, con el permiso y módulo existentes del comandero, reúne los tres canales (`staff`, `table`, `takeaway_web`) y filtra por fecha local, estado de comanda, todo servido, todo anulado o con platos listos. Despliega nota general y líneas con su destino actual y enlaza a su gestión. El selector de fecha es propio y admite todas las fechas.
- Los platos de categorías inactivas (como «Solo en el menú» del seed) no aparecen sueltos en el comandero. Permanecen disponibles en las elecciones del menú del día. No se cambia su precio a un importe ficticio.

### Reparto de la implementación entre cuatro agentes en paralelo

Los cuatro parten de `main` **después de integrar este contrato** y el diseño final. Cada uno usa su worktree y fila de puertos de `docs/tareas/etapa-0-reparto.md`. Esta tabla es un reparto futuro: no autoriza a tocar esas carpetas durante K. Contrato y core quedan congelados; si hace falta cambiar una firma lo centraliza el coordinador antes de continuar con el código dependiente.

| Agente / rama propuesta | Propiedad exclusiva | Entrega y prueba principal |
|---|---|---|
| 1 · Backend · `fase2/backend` | `functions/src/fase2/**`, sus exportaciones, integración mínima de reservas, `firebase/**`, `tests/rules/**`, `scripts/seed-fase2.ts`, procesador local de recogidas; toda modificación de functions y reglas | las 28 callables, transacciones/bloqueos, gasto, actividad, proyección, Storage, índices, seed idempotente; integración de doble apertura, cliente/precio manipulado, token de otra mesa/local, doble dueño y reintentos de gasto |
| 2 · Comandero y sala · `fase2/comandero` | páginas `/panel/comandero`, `/panel/para-llevar`, componentes `comandero/**`, `tareas/**`, ampliación de `/panel/sala` y sus componentes; `lib/comandero/**` | abrir/sentar, pedir con variantes y menús, aprobar, marchar, servir/anular, mover/juntar/separar, tareas con dueño y gestión de recogidas; prueba de sesión que cambia mientras se pide |
| 3 · Cocina y barra · `fase2/cocina` | páginas `/panel/cocina`, `/panel/barra`, componentes `cocina/**`, `lib/cocina/**` | listeners por estación, tickets y pases, empezar/listo/deshacer, agotados de su estación, reloj y avisos solo por retraso; pruebas de aislamiento de estación y comanda repartida entre dos mesas |
| 4 · Carta y pedido público · `fase2/carta-publica` | páginas `/panel/carta`, `/panel/configuracion-sala`, `/m/**`, `/r/[slug]/carta`, `/r/[slug]/para-llevar/**`, componentes y `lib/carta/**`, `lib/mesa-publica/**`, `lib/para-llevar-publico/**` | editor de carta/fotos/estaciones/ajustes, generación QR/NFC, tres idiomas, carrito público con revisión de precio, llamar/cuenta y seguimiento para llevar; prueba móvil QR → pedido → aceptación → servido y recogida pública |

Para evitar conflictos, cada frontend valida y llama `CALLABLE_SCHEMAS` desde su propia carpeta de lógica, usando la sesión/Firebase ya existentes, sin editar el cliente común ni añadir tipos duplicados. El agente 1 no edita web; el 4 administra carta y ajustes pero no el backend ni la gestión interna de recogidas del agente 2. Navegación, páginas iniciales, dependencias, `package.json`, lockfile, `lib` compartida, `ARQUITECTURA.md` y registro en `PLAN.md` los modifica solo el coordinador al integrar; los agentes entregan sus entradas de menú y módulos como datos en el informe. No se edita la página pública de reservas existente para añadir enlaces hasta esa integración.

Backend y frontends avanzan en paralelo contra los esquemas exportados. Las pruebas unitarias pueden usar fixtures claramente identificadas; una pantalla que aún no tenga backend muestra que falta implementarlo, nunca éxito ficticio. Integración: backend primero, carta/configuración después, comandero y cocina a continuación; coordinador conecta menú y accesos y recorre reserva → mesa → pedido → estación → recogida → cierre, además de QR y para llevar, con emuladores y capturas de escritorio, tableta y móvil. Cada agente ejecuta las comprobaciones comunes y el backend también reglas/Storage en sus puertos. Nada de este reparto requiere cuentas ni servicios en la nube.

## Fase 3 · Caja

Este es el contrato de la fase 3. Core entrega esquemas, API, cálculos y pruebas; la pantalla de caja y la fila de impresión local ya tienen implementación. El backend de caja, impresión y móvil están conectados en la entrada común; reglas, índices y navegación están integrados. El recorrido reproducible está en `docs/diseno/capturas/fase3/README.md`. Todo continúa en `demo-llenamos`, sin cuentas, envíos fiscales ni Stripe real. `pos` ya existe y pertenece al plan `completo`; no se cambia el catálogo de módulos ni los planes. El reloj entra como dato, los importes son céntimos enteros seguros y core no importa Firebase ni Node.

### Servicio, cuenta, cobro y factura

Son cuatro hechos distintos. `TableSession`, `Takeaway`, `Order` y `OrderLine` siguen siendo los de fase 2. Abrir una cuenta no abre otra sesión ni suma otra visita. `Bill.target` referencia exactamente una sesión o un para llevar del mismo local; el índice privado `billTargets/{sha256Hex(JSON.stringify([kind,id]))}` garantiza una sola cuenta vigente por destino. Se leen las **líneas con su destino actual**, no `orders.sessionId` ni `Order.totalCents` históricos. El padre del menú y sus componentes suman una vez; el reparto por platos mueve el padre con todos sus hijos, nunca un suplemento suelto. No se aceptan líneas pendientes de aprobación.

El servidor obtiene los importes congelados de las líneas. Fase 3 añade `OrderLine.taxRate` y `LineDraft.taxRate`: `planOrderLines(priced, items, stations, settings, dailyMenus)` copia el IVA del plato o del menú. El menú cerrado aplica el IVA del menú al padre y suplementos; productos con tratamiento diferente deben venderse aparte. `nextItemVersion` y `nextDailyMenuVersion` también versionan cambios de IVA. La firma de cuatro argumentos sigue funcionando para fase 2 y deja nulo el IVA desconocido del menú. **El backend de fase 3 debe pasar el quinto argumento y guardar ese campo**, también al aceptar pedidos que ya tenían precio congelado. Ausente o nulo significa histórico anterior: `billLinesFromOrderLines` rechaza el cobro hasta que el encargado confirme una migración con evidencia y actividad; nunca se rellena con el IVA actual ni un 10 % por defecto.

`open` permite refrescar las líneas y ajustar o repartir. `prepararCobro` relee el destino y congela instantánea y partes pasando a `locked`. Desde entonces el backend de sala rechaza pedidos, anulaciones de líneas, reaperturas, juntar, separar y cambios de destino que alteren esa cuenta. Mover solo la etiqueta física de una sesión bloqueada también se rechaza en esta fase para simplificar la concurrencia. Las comprobaciones se añaden a **todas** las entradas públicas y del personal de fase 2 dentro de sus transacciones. Una cuenta `open` se refresca antes de preparar el cobro y sube `revision` si cambió el servicio, invalidando el reparto anterior. La revisión cambia al refrescar consumo, ajustar, repartir, bloquear o desbloquear, actualizando también la revisión de las partes. Cobros parciales, factura y respuestas del proveedor no la incrementan: conservan la misma instantánea y validan el saldo actual dentro de la transacción. `expectedRevision` obsoleta devuelve `failed-precondition` y obliga a recargar, sin aplicar nada.

Cerrar la sesión o recoger el para llevar sigue siendo una decisión de servicio, con los requisitos de fase 2. Con `pos` activo, además exige cuenta `settled` o un destino sin consumo; sin `pos`, conserva el cierre de fase 2. Pagar no sirve platos ni libera mesas automáticamente. El backend de caja puede facturar una sesión ya cerrada antes de activar `pos`, con revisión explícita del histórico. `customers.spentCents` sigue siendo **consumo registrado** por `spendContributions`, no ingreso fiscal ni cobro neto: ningún pago vuelve a sumarlo. La caja muestra ingresos y devoluciones desde su libro de pagos; las invitaciones no cambian silenciosamente la métrica histórica de consumo. Se conserva la atribución de gasto de mesas juntadas de fase 2. Cambiarla queda fuera.

### Datos y autores

Todos los documentos siguientes son **solo de servidor**, incluidos ajustes e impresoras. Las funciones toman el autor de Auth, comprueban miembro activo y `locationIds`; nunca admiten `updatedBy` ni rol en la entrada. Guardan `createdAt`, `updatedAt` y `updatedBy` del servidor para operaciones autenticadas; público/sistema llevan autor nulo cuando corresponda. Core acepta Timestamp al leer y ofrece adaptadores `xxxForWrite` con conversor recibido. Las fechas fiscales son excepciones deliberadas: se conservan como texto literal y no se reinterpretan al leer.

```
restaurants/{rid}
  fiscalChains/{chainId}           issuerNif, installation, regime, head {recordId,hash,issuerNif,number,issueDate,sequence}|null
  fiscalRecords/{recordId}         FiscalStoredRecord + locationId + invoiceId + régimen + artefacto
  fiscalOutbox/{recordId}          estado de envío, intentos, lease, próxima ejecución
  fiscalResponses/{responseId}     respuesta y CSV inmutables por intento
  fiscalRequestKeys/{key}          resultado idempotente privado
  invoiceNumbers/{hash}           locationId, invoiceId; unicidad de NIF/serie/número
  locations/{lid}
    settings/pos                  PosSettings
    bills/{billId}                Bill
    billParts/{partId}            BillPart
    billAdjustments/{id}          BillAdjustment + billId; auditoría inmutable
    payments/{paymentId}          Payment
    cashSessions/{id}             CashSession
    cashMovements/{id}            CashMovement
    tipDistributions/{id}         TipDistribution
    invoices/{invoiceId}          Invoice + recordId + artefacto fiscal original
    invoiceEvents/{id}            anulación, sustitución o rectificación referenciada; inmutable
    invoiceSeries/{seriesId}      InvoiceSeries
    paymentReservations/{partId}  PaymentReservation
    billTargets/{hash}            billId
    registerLocks/{registerId}    cashSessionId|null
    posRequests/{hash}            requestId, actor, payloadHash, resultado
    depositApplications/{reservationId}     reserva, paymentId, importe aplicado acumulado
    paymentEvents/{externalIdHash} paymentId; índice privado contra duplicados externos
    mobileCheckouts/{checkoutId}  MobileCheckout + cashSessionId, destinatario, consentimiento
    digitalReceipts/{receiptId}   DigitalReceipt
    printers/{printerId}          Printer
    printRequests/{requestId}     PrintRequest
    printJobs/{printJobId}         PrintJob
    printStatuses/{printJobId}     PrintStatus sin bytes ni credenciales
    printBridges/{bridgeId}        tokenHash, revocado, rotatedAt; privado
    printLeases/{jobId}            leaseTokenHash, propietario; privado
```

`settings/pos` no tiene valores fiscales inventados por defecto. Contiene emisor (`name,nif,address`), sistema (`producerName,producerNif,name,id,version,installation,onlyVerifactu,multiTaxpayer,multipleTaxpayers`), `fiscalRegime`, `providerId`, `environment`, series ordinaria/rectificativa y `mobilePayments`. Sin configuración: no se factura y la interfaz lo explica. El cambio de emisor, instalación, régimen o series con uso exige migración del proveedor; no puede reiniciar cadenas ni contadores desde ajustes. Una instalación pertenece a un obligado. En esta implementación centralizada la cadena es por NIF e instalación del SIF a nivel restaurante, **compartida por todos sus locales, series y años**, con altas y anulaciones en orden de generación; no una por caja, año o serie. El alta de dos restaurantes con el mismo NIF e instalación debe impedir duplicar esa instalación o pasar por una migración coordinada. Ver [trazabilidad de la AEAT](https://sede.agenciatributaria.gob.es/Sede/iva/sistemas-informaticos-facturacion-verifactu/preguntas-frecuentes/caracteristicas-requisitos-sif-trazabilidad.html).

Los campos de negocio completos están en los esquemas de `caja/modelo.ts` y `caja/fiscal-modelo.ts`, exportados desde `@llenamos/core`:

| Documento | Contenido y responsabilidad |
|---|---|
| Bill | `target,customerId,status,revision,lines,adjustments,totalCents,paidCents,refundedCents,openedAt,lockedAt,settledAt`. Líneas `{lineId,parentLineId,name,quantity,grossCents,taxRate,guest}`. Instantánea de servidor, no copia de carta actual |
| BillAdjustment | `id,lineId,kind: invitation|void,amountCents,reason,at,by`. Nunca excede el saldo de la línea. Se conserva además como evento inmutable; correcciones posteriores crean otro documento fiscal |
| BillPart | `billId,label,revision,allocations[{lineId,amountCents}],totalCents,paidCents,invoiceId`. Todas las partes juntas conservan cada céntimo y línea de la cuenta |
| Payment | `billId,partId,cashSessionId,kind: charge|refund,originalPaymentId,method: cash|card|stripe|deposit,status,amountCents,tipCents,tenderedCents,changeCents,externalId,requestId,reason,at,by`. Solo importes confirmados entran en totales; los movimientos confirmados no se editan |
| CashSession | `registerId,status,openingCents,openedAt,openedBy,closedAt,closedBy,countedCents,expectedCents,differenceCents,closeReason`. Solo una apertura vigente por terminal; cierre irreversible con instantánea de movimientos |
| CashMovement / TipDistribution | entradas, salidas y pago de propinas con importe, motivo, autor y hora; reparto guarda minutos por uid y todos los céntimos asignados |
| InvoiceSeries | `prefix,kind: ordinary|rectifying,year,lastSequence,lastIssueDate,active`. El servidor asigna y controla cronología; prefijo único por obligado. No se permite cambiar ni borrar una serie usada |
| Invoice | identificadores internos de cuenta/parte/serie, emisor y destinatario congelados, `sequence,number,issueDate,operationDate,type,qualifiedSimplified,description,lines,taxes,taxCents,totalCents,correction,replacedInvoices`. Sin estado mutable: las incidencias van en eventos y respuestas |
| MobileCheckout | parte, revisión, importe, propina, estado, sesión externa, caducidad y hash del token. Datos de facturación y consentimiento se congelan antes de crear Checkout |
| DigitalReceipt | factura, hash propio del enlace, caducidad, correo opcional, consentimiento y estado real de entrega; un recibo no crea otra venta |
| Printer / PrintRequest / PrintJob | perfil térmico y estaciones; petición durable semántica; trabajo con bytes base64 y hash, copia, estado, intentos y lease. La web no envía bytes, IP ni órdenes de cajón |

### Permisos, módulos y reglas

`FASE3_ACCESS` es la fuente de verdad para callables. Caja nueva exige `pos`; cuentas y cobro desde destinos exigen además `floor`. Auditoría, ajustes, rectificativas y recibos históricos no requieren mantener `floor` encendido. Las operaciones que sirvan/cierren reservas siguen exigiendo sus permisos y módulos respectivos. Apagar módulos nunca borra el historial ni cancela una obligación de envío ya generada; el trabajador fiscal y la reconciliación de pagos completan lo previamente adquirido, sin crear ventas nuevas.

| Permiso | owner | manager | waiter | kitchen | bar |
|---|---|---|---|---|---|
| caja.ver, caja.cobrar | ✓ | ✓ | ✓ | | |
| caja.gestionar (aperturas, movimientos, cierre y propinas) | ✓ | ✓ | | | |
| caja.rectificar (invitar, anular consumo, devolver y rectificar) | ✓ | ✓ | | | |
| caja.configurar, impresion.gestionar | ✓ | ✓ | | | |

| Ruta | Lectura desde SDK cliente | Escritura cliente |
|---|---|---|
| bills, billParts | caja.ver, pos, floor, miembro activo y local permitido | nunca |
| payments, invoices, invoiceEvents | caja.ver, pos, miembro activo y local permitido | nunca |
| billAdjustments, cashSessions, cashMovements, tipDistributions | caja.gestionar o caja.rectificar según documento, pos y local | nunca |
| settings/pos | caja.configurar, pos y local; el camarero no necesita datos del productor | nunca |
| invoiceSeries, printers | owner/manager, pos y local | nunca |
| printStatuses | caja.ver, pos y local; solo estado, nunca payload/lease/token | nunca |
| fiscalRecords, fiscalChains, fiscalOutbox, fiscalResponses y todos los índices/bloqueos/tokens/payloads | nadie desde SDK cliente; auditoría por backend autenticado | nunca |
| mobileCheckouts, digitalReceipts, printRequests, printJobs, printBridges, printLeases, paymentReservations | nadie desde SDK cliente | nunca |

No hay colección fiscal pública ni permiso por conocer un id. Las consultas exigen filtro de restaurante/local y estados según cada lector; Firestore no filtra documentos. Backend añade índices concretos para cuentas por destino/estado, partes por cuenta, pagos por caja/parte/hora, facturas por fecha/serie, envíos por estado/próximo intento y trabajos por impresora/estado. Pruebas de reglas positivas y negativas por rol, módulo, local y token. No se modifican reglas en la entrega de contrato.

### API de implementación

Los 27 nombres de `api-caja.ts` se integran en `CALLABLES`, `CALLABLE_SCHEMAS` y `CallableInput/ParsedInput/Output`, región `europe-west1`. Entradas estrictas, salidas ampliables, instantes en ms. **S** = `{restaurantId,locationId}`; **M** = S más `requestId`; **B** = M más `billId,expectedRevision`; **C** = `{slug,locationId,checkoutId,token}`. `requestId` estable por intención, aleatorio e independiente de los tokens, obligatorio en toda mutación del personal. No se aceptan precios, total fiscal, autor, número de factura ni estado de confirmación del móvil.

| Callable | Entrada adicional | Salida | Permiso y responsable |
|---|---|---|---|
| guardarConfiguracionCaja | M, settings | ok | caja.configurar; backend |
| abrirCaja | M, registerId, openingCents | cashSessionId | caja.gestionar; backend |
| cerrarCaja | M, cashSessionId, countedCents, reason|null | ok, cashSession | caja.gestionar; backend |
| registrarMovimientoCaja | M, cashSessionId, kind in/out, amountCents, reason | movementId | caja.gestionar; backend |
| abrirCuenta | M, target | billId, bill | caja.cobrar; backend |
| verCuenta | S, billId | bill, parts con id | caja.ver; backend |
| ajustarCuenta | B, lineId, kind invitation/void, amountCents, reason | ok, revision, totalCents | caja.rectificar; backend |
| dividirCuenta | B, split equal/amount/dishes | revision, parts con id | caja.cobrar; backend |
| prepararCobro | B | ok, revision | caja.cobrar; backend |
| desbloquearCuenta | B, reason | ok, revision | caja.rectificar; backend |
| registrarCobro | B, partId, cashSessionId, method cash/card/deposit, amountCents, tipCents?, tenderedCents?, terminalReference? | paymentId, changeCents, dueCents | caja.cobrar; backend |
| devolverCobro | M, paymentId, amountCents, tipCents?, reason | refundId, status succeeded/pending/not_configured | caja.rectificar; backend |
| emitirFactura | B, partId, type F1/F2, recipient|null, qualifiedSimplified? | invoiceId, recordId, number, fiscalStatus queued/not_configured, warning|null | caja.cobrar; backend |
| rectificarFactura | M, invoiceId, type R1…R5, mode I/S, reason, reductions[{lineIndex,amountCents}] | igual que emitirFactura | caja.rectificar; backend |
| sustituirSimplificada | M, invoiceId, recipient | igual que emitirFactura | caja.cobrar; backend |
| anularRegistroFiscal | M, invoiceId, reason | recordId, fiscalStatus | caja.rectificar; backend |
| repartirPropinas | M, cashSessionId, hours[{uid,minutes}] | distributionId, shares | caja.gestionar; backend |
| guardarImpresora | M, printerId|null, printer | printerId | impresion.gestionar; impresión |
| vincularPuente | M, bridgeId | token nuevo, mostrado una vez | impresion.gestionar; impresión |
| solicitarImpresion | M, printerId, kind, sourceId, copy? | printJobId, status queued/not_configured | caja.cobrar; impresión; drawer exige además caja.gestionar |
| reclamarImpresiones | S, bridgeId, token, limit? | jobs[{id,payloadBase64,leaseToken,leaseUntil}] | credencial del puente y sus impresoras; impresión |
| confirmarImpresion | S, bridgeId, token, printJobId, leaseToken, status printed/failed/uncertain, error|null | ok | puente y lease vigentes; impresión |
| crearEnlaceCobro | B, partId | checkoutId, token, path, expiresAt | caja.cobrar; móvil |
| verCobroPublico | C | PublicBill con nombre/importe de su parte, local, caducidad y estado | token propio; móvil |
| iniciarPagoCuenta | C, requestId, tipCents?, recipient?, acceptDigitalReceipt, email?, website? vacío | ready con url o not_configured con message | token propio; móvil |
| crearReciboDigital | M, invoiceId, email|null, acceptDigitalReceipt | receiptId, token, path, delivery | caja.cobrar; móvil |
| verReciboDigital | slug, locationId, receiptId, token | invoice filtrada, qrUrl, legend, warning | token propio; móvil |

El backend valida relaciones, no solo formas zod: parte de esa cuenta, caja del mismo local, línea de esa instantánea, receptor permitido para tipo, serie adecuada y mismo obligado en referencias fiscales. Falta de acceso: `permission-denied`; revisión/saldo/estado obsoleto: `failed-precondition`; claves repetidas con otro contenido: `already-exists`; datos mal formados: `invalid-argument`. Todo con mensaje en castellano. Una llamada repetida con mismo actor, ruta y `requestId` y mismo hash de entrada devuelve el resultado original, incluso número y cambio; no vuelve a ejecutar efectos. Los resultados con tokens se conservan en el registro privado de intención con acceso exclusivamente servidor y plazo corto para recuperar una respuesta incierta; no se registran en actividad ni errores.

### Céntimos, estados y concurrencia

`netBillLines` valida ajustes acumulados sin negativos. `splitBill` reparte por partes iguales, platos o importes de suma exacta. En iguales, el sobrante va al orden persistido de partes; en importes, una matriz de restos mayores conserva tanto el total de cada línea como el de cada parte. El servidor verifica ids únicos y el conjunto completo de asignaciones. No se fracciona cantidad física en esta fase: un plato compartido se reparte por importe; `guest` ayuda a preseleccionar, no identifica un pagador.

IVA incluido: `base = redondear(gross × 100 / (100 + tipo))`, cuota = bruto menos base, agrupado una vez por tipo y **factura**. Se usan BigInt en productos y reparto, con retorno a enteros seguros. Dos facturas distintas pueden redondear su IVA de forma distinta a una factura conjunta: conservan el bruto, y la contabilidad toma el desglose de cada documento emitido. `invoiceLinesForPart` representa una participación con cantidad 1 y descripción, mantiene fuente y bruto; no inventa precios unitarios fraccionarios. Las propinas voluntarias quedan fuera de base/total fiscal, nunca se incluyen servicios obligatorios como propina. El tratamiento de autoconsumo por invitaciones y casos especiales de IVA queda **a confirmar con el proveedor**: esta fase implementa reducción comercial sobre la cuenta, con motivo, no una declaración automática de autoconsumo.

| Entidad | Transiciones |
|---|---|
| Bill | open → locked/cancelled; locked → open solo sin cobros, factura ni reservas de pago; locked → settled cuando saldo cero y sin pagos pendientes; settled/cancelled finales |
| Payment | pending → succeeded/failed/cancelled; los confirmados no se editan, se compensan con un Payment refund |
| CashSession | open → closed, nunca se reabre ni se modifica el arqueo confirmado |
| Invoice/FiscalRecord | solo creación; rectificación, sustitución, subsanación y anulación siempre son nuevos registros/eventos |
| FiscalOutbox | queued → accepted/accepted_with_errors/rejected/retry/not_configured; retry → nuevo intento del mismo XML; rechazo exige actuación documentada |
| MobileCheckout | pending → paid/expired/failed/reconciliation_required; pago tardío no reabre ni refactura una cuenta |
| PrintJob | queued → leased/cancelled; leased → printed/failed/uncertain; failed → queued/cancelled; printed/uncertain/cancelled finales |

Todo consumo de saldo se hace transaccionalmente leyendo Bill, partes, pagos/reservas vigentes y caja abierta. `checkCharge` descuenta reservas, y `checkRefund` incluye devoluciones pendientes para no reservarlas dos veces. La devolución debe referenciar el cobro original exacto, mismo método y parte; el backend filtra los reembolsos de ese id antes de llamar al cálculo puro. No se devuelve más consumo ni propina de los realmente cobrados. Una devolución no reabre automáticamente saldo ni mesa: necesita su corrección fiscal asociada si cambia la operación; devolución y rectificativa son hechos coordinados, no sustitutos. Una devolución exclusiva de propina tiene `amountCents: 0, tipCents > 0` y no rectifica la factura de consumo. El datáfono externo se registra como `card` con referencia, nunca como Stripe ni como integración bancaria verificada. El efectivo separa consumo, propina, entrega y cambio; no se cuenta la entrega íntegra como ingreso.

La señal de fase 1 solo se aplica si la reserva de la sesión tiene `deposit.status: paid`, se verifica importe real y no estaba reembolsada/aplicada. Se imputa una sola vez mediante índice transaccional, sin otra entrada de efectivo; una aplicación parcial conserva saldo de la señal. El tratamiento fiscal del anticipo debe **confirmarse con el proveedor** antes de usar señales reales: se necesita factura de anticipo y su deducción sin duplicar base/IVA. La integración local prueba la aplicación contable; no declara resuelta esa fiscalidad ni emite doble venta. Sin evidencia fiscal del anticipo, `registrarCobro(method: deposit)` rechaza en producción.

Abrir caja lee `registerLocks`; cerrar exige que no haya reservas/pagos externos pendientes imputados a ella, congela el libro y rechaza nuevos movimientos. Arqueo = fondo + cobros de efectivo confirmados + propinas en efectivo − devoluciones en efectivo − salidas + entradas. La diferencia exige motivo no vacío si no es cero. Las propinas se reparten una vez por caja cerrada, netas de devoluciones, mediante `distributeTips`: minutos enteros aprobados manualmente hasta que exista fichaje, uid ordenado para desempates. El pago físico de propinas es un movimiento `tip_payout` en una **caja abierta posterior** que referencia el reparto; no altera un cierre antiguo. No se confunde ese pago con otra propina ni se distribuye dos veces. No hay nóminas ni fiscalidad laboral automática.

### Registro fiscal y adaptador

Diseño contrastado con [RD 1007/2023, arts. 8 a 12](https://www.boe.es/buscar/act.php?id=BOE-A-2023-24840) y [Orden HAC/1177/2024 y su anexo](https://www.boe.es/buscar/act.php?id=BOE-A-2024-22138), consultados el 09/11/2026. El registro conserva identidad fiscal, datos del emisor, tipo, operación, destinatario cuando corresponde, desglose, totales, anterior, sistema productor, versión e instalación y hora con huso. La anulación conserva identidad anulada, sistema, fecha/huso y anterior; no borra el alta. Se guardan XML UTF-8, cadena canónica, hash y control local adicional de la instantánea completa. Al guardar el artefacto junto a `FiscalStoredRecord`, se omite su campo `record` redundante; se conservan `regime,xml,qrUrl,legend,warning,validForTaxAuthority,ticketbai`. La escritura es append only, también desde Admin: el servicio usa create, no update/delete sobre originales. Reglas por sí solas no protegen Admin.

`verifactuHashInput`, `verifactuHash` y `verifactuRecordXml` siguen los campos y orden de alta/anulación del [documento de huella AEAT 0.1.2](https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/Veri-Factu_especificaciones_huella_hash_registros.pdf). Se concatenan nombres y valores recortados, separador `&`, sin escape XML ni URL previo al hash, UTF-8 y SHA-256 hexadecimal mayúsculo. Importes con punto y dos decimales; anterior vacío solo al empezar. Las pruebas reproducen sus tres vectores oficiales. `verifyFiscalChain` detecta cambios, orden y huecos y contrasta identidad/hash del anterior; también compara XML y hash local de todos los datos.

El backend serializa emisiones con la cabeza de `fiscalChains` en transacción. Antes de generar, comprueba la cabeza y su anterior, incluyendo integridad y sistema; si falla, bloquea nuevas emisiones, registra una incidencia y conserva pruebas. Valida tamaño de documento y configuración antes de incrementar nada. Factura, correlativo, índice de número, registro, nueva cabeza, actividad y outbox se crean en una sola transacción. `nextInvoiceNumber` no reserva ni consume por sí mismo. No hay rangos, números asignados al imprimir, saltos al fallar la red ni reinicio de cadena anual. Una factura anulada conserva su número; la siguiente no lo reutiliza. Cada prefijo identifica local, año y clase de documento, con serie rectificativa separada. `guardarConfiguracionCaja` crea si faltan las series `ordinary_{año}` y `rectifying_{año}` del local, con contador cero y prefijos `L{primeros 20 hex mayúsculos de sha256Hex(JSON.stringify([rid,lid]))}/{año}/F` y `/R`. Solo admite esos ids para nuevas series; si el prefijo colisiona se rechaza y lo resuelve la migración del proveedor. El rollover anual crea nuevas series en servidor sin modificar las usadas y conserva la misma cadena fiscal. No hay numeración libre enviada por cliente. El backend valida fecha fiscal en el huso del emisor, cronología y deriva emisor/sistema/fechas/series del servidor, nunca del cliente.

`InvoiceSchema` distingue F1 completa o simplificada cualificada, F2 simplificada sin receptor, F3 sustitución de simplificadas y R1…R5 rectificativas. Emisor con NIF, nombre y domicilio; completa con identidad, nombre y domicilio del receptor. Simplificada ordinaria de restauración hasta 3000 € IVA incluido; el servidor exige completa si corresponde o se solicita. Se imprimen número/serie, fechas de expedición y operación, conceptos, cantidades, descuentos, tipos, bases/cuotas, total y referencias de corrección. Requisitos de factura en [RD 1619/2012, arts. 4, 6, 7 y 15](https://www.boe.es/buscar/act.php?id=BOE-A-2012-14696). La validación del NIF en core es de formato; su dígito de control, identificación censal y casos de receptores extranjeros se verifican en el proveedor real.

Una parte se factura una vez, aunque tenga varios pagos parciales. Se puede emitir al comenzar el cobro con cuenta bloqueada; una prefactura no obtiene numeración. La anulación fiscal solo corrige una emisión que no debió existir y documenta la ausencia de operación o su reversión pertinente, revisada por encargado; **no** sustituye a la rectificativa de una venta real. Devolver consumo de una venta real crea rectificativa con motivo y referencia exacta. `rectifyInvoice` implementa reducciones: I emite diferencias negativas; S emite resultado corregido y referencia base/cuota originales. El backend descuenta las reducciones ya rectificadas para evitar excesos y verifica el tipo R apropiado. Aumentos, cambios de tipo fiscal y rectificar otra rectificativa requieren revisión del proveedor y quedan fuera del flujo automático. F3 conserva el bruto original, enlaza F2 sustituida, no reingresa dinero, no vuelve a contabilizar ventas ni anula por error el alta sustituida. Subsanar un rechazo técnico no consume otro número: el trabajador autorizado genera un registro adicional con misma identidad, `subsanacion/previousRejection/correctionOfRecordId` según corresponda, preservando el anterior y pasando por el mismo bloqueo. Si cambia la realidad económica se usa rectificativa.

El XML entregado cubre operación interior IVA general `01`, calificación `S1` y tipos 0/4/10/21. El 0 es tipo cero sujeto, no exención automática. IGIC, IPSI, recargo de equivalencia, exentas/no sujetas, regímenes especiales, tercero/destinatario emisor, acuerdos o resoluciones de excepción quedan **a confirmar con el proveedor** y se rechazan hasta ampliar explícitamente el contrato. No se inventan códigos. El XML es un registro individual de conservación/exportación, no el sobre SOAP. Se han validado localmente seis muestras (F1, F2, F3, R4 por I/S y anulación) con `xmllint` contra el [XSD oficial AEAT](https://prewww2.aeat.es/static_files/common/internet/dep/aplicaciones/es/aeat/tikeV1.0/cont/ws/SuministroInformacion.xsd); el backend debe ampliar esa validación y añadir cabecera, autenticación, respuestas, esperas, lotes y subsanaciones del servicio elegido.

`verifactuQrUrl` usa los cuatro parámetros oficiales (`nif,numserie,fecha,importe`), URL encoding, fecha DD-MM-AAAA e importe decimal. Bases de cotejo separadas para pruebas y producción; el proveedor local siempre utiliza pruebas. Según [QR AEAT 0.5.0](https://www.agenciatributaria.es/static_files/AEAT_Desarrolladores/EEDD/IVA/VERI-FACTU/DetalleEspecificacTecnCodigoQRfactura.pdf): QR M, 30 a 40 mm, posición preeminente al principio, texto «QR tributario» y leyenda visible «VERI*FACTU» en modalidad verificable. Se reserva blanco alrededor; el perfil usa 35 mm objetivo y 6 mm de margen, al menos 2 mm y cuatro módulos. El QR digital representa la misma URL, nunca la del recibo. No se agrega `formato=json` al QR.

`FiscalProvider` tiene `id`, `regimes`, `prepare(FiscalPreparation): FiscalArtifact` sin red y `submit(artifact,idempotencyKey): Promise<FiscalSubmission>`. La preparación no llama a Hacienda dentro de una transacción. `FiscalArtifact` separa XML, registro normalizado, QR, leyenda, advertencia y datos TicketBAI. `createTestFiscalProvider()` calcula todo lo implementado para VERI*FACTU y devuelve siempre `not_configured` al enviar, sin fetch ni claves; `validForTaxAuthority: false` y **«no válido para Hacienda»** deben aparecer en caja, ticket y recibo. No es una modalidad legal «no VERI*FACTU» ni permite facturar en producción. El backend deniega este proveedor fuera de demo/emuladores.

TicketBAI tiene tres regímenes explícitos (`ticketbai_araba`, `ticketbai_bizkaia`, `ticketbai_gipuzkoa`) en el mismo puerto. Recibe factura normalizada y la firma/referencia anterior propias, devuelve XML firmado, identificador, licencia, firma y QR foral, sin reutilizar el hash ni QR AEAT como si fueran TicketBAI. El [Gobierno Vasco](https://www.euskadi.eus/ticketbai/) y la [documentación técnica de Araba](https://web.araba.eus/es/hacienda/ticketbai/documentacion-tecnica) describen firma y encadenamiento. XSD/versión, política XAdES, certificados, licencia de software garante, algoritmo exacto de identificador/QR, endpoints, anulación, plazos y particularidades Batuz/LROE están **a confirmar con el proveedor** por territorio. El proveedor local rechaza estos regímenes antes de consumir número. Si el proveedor real requiere firma remota, se amplía la preparación con una cola de firma y bloqueo duradero antes de habilitarlo; no se mantiene una transacción Firebase durante una petición de red.

Outbox fiscal con exclusión por lease y orden de cadena; el id de registro es clave idempotente del proveedor. Timeout conserva el mismo XML, hash e identidad y consulta/reintenta sin emitir otra factura. `accepted_with_errors` y `rejected` se muestran para actuar, nunca se convierten en éxito local. Cada intento y respuesta/CSV se añade a un histórico. Se prevén verificación y exportación ordenada por obligado, copia segura y simulacro de restauración sin regenerar facturas ni reiniciar cabezas; política de conservación y restauración es responsabilidad del backend/proveedor antes de producción. Elegir proveedor con declaración responsable del productor y validar la integración completa sigue pendiente: este contrato y sus pruebas no son una certificación legal del producto.

### Pago móvil y recibo

El QR de fase 2 conserva sus operaciones de servicio; la capacidad aditiva para elegir partes preparadas se describe más abajo. El personal crea un enlace de pago limitado a cuenta, parte y revisión ya bloqueadas. Rutas nuevas: `/p/{slug}/{locationId}/{checkoutId}?t=…` y `/recibo/{slug}/{locationId}/{receiptId}?t=…`; tokens distintos de 32 bytes con `linkToken`, hash SHA-256 guardado. Pago caduca a los 15 minutos; recibo a los 30 días por defecto, renovable desde el panel. El token no viaja a Stripe ni se registra en actividad; páginas sin indexación, `Referrer-Policy: no-referrer`, sin analítica de terceros ni Firestore público. Se limitan peticiones por IP/token y `website` vacío al iniciar.

El enlace móvil cobra el saldo completo pendiente de esa parte, no un importe libre del navegador. Una reserva de saldo por parte se adquiere antes de crear Checkout y excluye efectivo, datáfono y otros enlaces competidores. Stripe recibe solo importe calculado, céntimos EUR, propina separada en metadatos y referencia privada de checkout; el servidor guarda el id externo. Cambios de receptor, correo o propina invalidan la intención anterior antes de crear otra. Un retorno `success_url` nunca confirma pago. El webhook propio de caja comprueba HMAC, antigüedad, evento repetido, sesión esperada, total con propina, EUR y pago completo antes de registrar el cobro. No reutiliza ni cambia `stripeWebhook` de señales. Eventos asíncronos y expiraciones usan el mismo índice de deduplicación y reserva. Un pago tardío o inesperado queda `reconciliation_required` con fondos trazables y tarea del encargado; no se pierde ni reabre una mesa cerrada. Una reserva no se libera solo por reloj local si la sesión externa puede seguir pagando: el procesador verifica expiración/cancelación en el proveedor. Un timeout de creación de Checkout se consulta con la misma clave de idempotencia.

Sin claves: `not_configured`, no sesión externa ni Payment succeeded ficticio. En pruebas se inyecta fetch y se usan cargas HMAC firmadas. Solo el webhook/servicio confiable confirma `stripe`. La emisión automática después de confirmar es idempotente por parte: si falla la configuración fiscal queda cobro confirmado pendiente de factura, con aviso visible y trabajo durable; jamás otro cobro para reintentar facturar. El recibo muestra solo su factura, sin ids internos, `sourceLineId`, teléfonos, notas privadas ni otras partes. Correo y consentimiento se piden aparte; sin consentimiento se ofrece papel y no se envía correo. El enlace muestra la misma factura fiscal con su QR, tipo y aviso de prueba; sin proveedor de correo se distingue captura local de envío real.

#### Implementación local del pago móvil

`functions/src/fase3-mobile/index.ts` exporta las cinco callables anteriores, el webhook propio y `reconciliarPagosMoviles` (cada cinco minutos). El coordinador debe registrar esas exportaciones en `functions/src/index.ts` y conectar una vez `connectCajaServices({ confirmExternalPayment, issuePartInvoice })` con `fase3/service.ts`. Sin esa conexión no se inicia ningún cobro. El módulo no escribe `payments`, saldos ni facturas: usa exclusivamente esos servicios. En esta rama se prueban transacciones móviles con Firestore real y el puerto de caja inyectado; **no se declara integrada ni probada la implementación de caja de la otra rama**. La entrada `local-entry.ts` y `tsup.local.ts` permiten probar las funciones móviles sin editar archivos compartidos; no son la entrada de despliegue.

Cuenta receptora aún por decidir: `STRIPE_MOBILE_MODE=single` cobra en la cuenta de la clave; `connect` exige `STRIPE_CONNECTED_ACCOUNTS` como JSON privado `{ "restaurantId": "acct_…" }` y envía `Stripe-Account` en creación, consulta y expiración. La ruta se congela en cada intento y el webhook comprueba `event.account`; el cliente nunca elige cuenta. Se necesitan `STRIPE_SECRET_KEY`, `STRIPE_MOBILE_WEBHOOK_SECRET` independiente de señales y `PUBLIC_APP_URL` (HTTPS fuera del emulador). En `demo-*` y emuladores se bloquea toda salida a Stripe, incluso con una clave puesta: las pruebas inyectan el transporte. No hay SDK ni claves reales. El adaptador usa cargos directos de Connect, sin comisión de plataforma configurada; decidir quién cobra sigue siendo una decisión comercial pendiente. Referencia técnica: [cargos directos con Checkout](https://docs.stripe.com/connect/direct-charges?platform=web&ui=stripe-hosted).

El enlace local caduca a los 15 minutos. Stripe Checkout requiere al menos 30 minutos para `expires_at` ([API de creación](https://docs.stripe.com/api/checkout/sessions/create)); se conserva esa caducidad externa por separado. La reserva no se libera por ninguna de las dos fechas: solo tras expiración externa confirmada o confirmación del servicio de caja. Al vencer el enlace, el worker consulta y solicita expiración. Una creación incierta conserva nombre, origen, idioma, importe y clave idempotente; se recupera con el mismo POST, sin token de cliente. Tras 23 horas sin recuperar sesión se pasa a revisión para evitar reutilizar una clave ya olvidada por Stripe. Una intención iniciada congela destinatario, correo y propina: los cambios se rechazan mientras no se haya confirmado la cancelación del intento anterior. Se exige una sola caja abierta por local para imputar el móvil sin elección ambigua de terminal.

Para llegar **desde el QR**, se añade una capacidad limitada a cuentas ya bloqueadas por el personal, sin ampliar la exposición de recibos. Ruta `/p/{slug}/{locationId}/mesa/{tableId}?t=…`. Dos callables aditivas, con esquemas estrictos en `fase3-mobile/service.ts`: `verPartesPagoMesa({slug,locationId,tableId,token})` devuelve marca, cuenta/revisión, total y partes `{id,label,amountCents}`; `elegirPartePagoMesa` añade `billId,partId,expectedRevision,requestId` y devuelve un enlace privado **nuevo** mediante el mismo servicio de creación. Ambas comprueban QR vigente, mesa habilitada, única sesión actual, destino de la cuenta y módulos `floor,pos`. El QR no entrega tokens de pago anteriores, recibos ni datos personales y no permite repartir ni bloquear la cuenta. La mesa pública enlaza a esas partes y Caja permite crear el enlace privado de una parte. `verMesaPublica` añade `canViewPayment?`, calculado por servidor con sesión actual y módulos `floor,pos`; sin ese campo se oculta el acceso. El enlace directo sigue limitado a una sola parte.

Sin modificar `caja/` ni `api-caja.ts`, las salidas públicas añaden marca, `paymentsEnabled`, propina, importe cobrado, recibo privado y factura pendiente; iniciar admite `language?` (`es` por defecto). La interfaz propia valida esas ampliaciones y conserva las firmas originales. Las páginas tienen metadatos sin indexación y referrer nulo; las respuestas de callables añaden `Cache-Control: no-store`, `Referrer-Policy: no-referrer` y `X-Robots-Tag`. La configuración común de Next aplica esos encabezados también a los documentos HTML `/p/**` y `/recibo/**`.

Documentos privados adicionales bajo el local, todos solo servidor: `mobileRequests` (huella, resultado idempotente y caducidad), `mobileStripeEvents` (evento firmado/consultado, cuenta externa, estado `queued|done`), `mobileIncidents` (tarea `open` con código y referencia externa para el encargado). `mobileCheckouts` conserva ruta Stripe, datos congelados de creación, destinatario, consentimiento, sesión, `needsReconciliation`, factura pendiente y enlace de recibo privado. Los índices de trabajo del worker se filtran por `needsReconciliation == true` y eventos `status == queued`, con límite por ejecución. `restaurants/{rid}/mobileRateLimits` contiene contadores separados por hash de IP y credencial, 60 solicitudes/minuto y fecha de limpieza. No se conceden lecturas SDK públicas sobre ninguna de estas rutas. Las reglas comunes mantienen estas rutas privadas; `mobileIncidents` tiene lectura exclusiva de owner/manager con `pos` y local permitido, visible en Caja. Los índices del worker están en `firebase/firestore.indexes.json`.

Único cambio mínimo y aditivo de core: plantilla `digital_receipt` y su etiqueta en `message-model.ts`, más asunto traducido en `mensajes/index.ts`. El recibo se encola en `restaurants/{rid}/messages` con `manageUrl` privado; lo consume el procesador existente, con sus estados reales. El id del mensaje deriva de factura, destinatario e intención: los reintentos no duplican envíos y una renovación explícita puede enviar otro enlace vigente. Sin consentimiento no hay correo. Recibo/factura de prueba muestran siempre **«no válido para Hacienda»**, incluso si falta el artefacto. El QR digital es local, nivel M, con zona blanca y URL fiscal original, contrastado con una matriz independiente; no llama a AEAT. Capturas y comprobaciones reproducibles en `docs/diseno/capturas/pago-movil/README.md`.

### Impresión y procesos

`invoicePrintDocument`, `kitchenPrintDocument`, `prebillPrintDocument`, `encodeEscPos` y `drawerPulse` proporcionan el formato. Perfil explícito: 58/80 mm, 32/48 columnas, CP858 y 203 ppp. Acentos castellanos soportados, caracteres no representables como `?`, controles eliminados para impedir inyectar órdenes. Los nombres largos saltan de línea sin desaparecer; el puente debe advertir si el repertorio de la impresora no admite el texto. El codificador QR M se recibe como función que devuelve matriz de módulos; core no añade dependencias ni imprime una matriz falsa. La codificación raster comprueba tamaño físico y margen y rechaza factura sin QR. El agente de impresión debe aportar codificador real y prueba de escaneo; compatibilidad, CP858, resolución y dimensiones reales **a confirmar con el proveedor de impresoras**. No se promete soporte universal ni impresión desde el navegador sin puente.

El puente es un proceso local que consulta trabajos autorizados con token propio rotatorio y lease. No abre un servidor local al que cualquier web pueda enviar comandos; redes/USB/IP de impresora son configuración local del puente. Los cuerpos quedan limitados por tamaño y hash, nunca se aceptan bytes del cliente público. La cola congela bytes y documento; reimprimir crea `copy > 0`, marca «Copia» y no asigna número fiscal ni envía de nuevo ni abre cajón. Pérdida de conexión después de escribir bytes produce `uncertain`, sin reenvío automático que pudiera duplicar tickets; se revisa y solicita copia manual. Un lease caducado tras envío también es incierto. Un trabajo fallido antes de enviar permite reintento explícito. Abrir cajón es un trabajo independiente y deduplicado asociado a cobro efectivo confirmado o a intervención autorizada con actividad; nunca depende de reimprimir.

| Proceso / dueño | Momento y garantía |
|---|---|
| Backend: actividad de caja | misma transacción de la decisión; `bill.opened/locked/adjusted/split/settled`, `payment.recorded/refunded`, `cash.opened/closed/movement`, `invoice.issued/rectified/replaced`, `fiscal.cancelled`, `tips.distributed`; actor real, motivo y referencias, sin tokens ni datos fiscales completos en resumen |
| Backend: remisión fiscal | worker por cadena y ejecución local explícita; outbox y respuestas durables, sin duplicar número ni registro por reintento |
| Móvil: reconciliación Stripe y factura pendiente | webhook y procesador local por vencimiento; índices de evento/reserva y emisión por parte, no por visita a una página |
| Impresión: generar y despachar | recibe `printRequests` durables de caja o fases de cocina; id determinista por origen/tipo/impresora/copia; transforma en `printJobs`, reclama y confirma con lease |
| Impresión: comanda marchada | observa transición a fired por estación/pase/destino actual; usa las mismas líneas congeladas de cocina y deduplica por marcha, no por render ni por trigger repetido |
| Móvil: entregar recibo | id determinista por factura/canal, consentimiento guardado, queued/captured/sent/not_configured/failed reales; no modifica el documento fiscal |

### Implementación de impresión local

La fila `fase3/impresion` aporta `functions/src/fase3-print`, `tools/print-bridge` y `/panel/impresoras`. Las exportaciones, menú de Impresoras, reglas e índices están integrados. `tools/print-bridge/README.md` conserva el detalle de la entrega de origen.

Ampliación mínima y aditiva de `api-caja.ts`: `solicitarImpresion.kind` acepta `test` (solo `impresion.gestionar`, se guarda como precuenta claramente identificada, sin venta ni cajón). La salida de `reclamarImpresiones.jobs` añade `printerId` y `payloadHash`, necesarios para resolver la dirección local y verificar los bytes. No cambia ningún cálculo de caja ni firma existente. El puente Node no tiene dependencias adicionales.

Los trabajos guardan además `bridgeId` y `document` congelados, privados. `printIntents/{hash}` guarda la idempotencia de las mutaciones y `expiresAt`; las respuestas con credencial se recuperan durante diez minutos, siempre que siga siendo la credencial vigente. `printCopies/{hash}.value` asigna copias sin colisiones. Ambas colecciones son solo de servidor. `printBridges` añade `lastSeenAt` interno. Se propone TTL de `printIntents.expiresAt`, sin activarlo en la nube.

El emparejamiento requiere miembro activo, permiso, módulo y acceso al local. Solo se guarda SHA-256 de la credencial en el puente lógico; el resultado recuperable de la vinculación queda temporalmente en el registro privado. Rotar invalida la credencial anterior. IP y puerto de impresora nunca se guardan en Firestore ni viajan en las reclamaciones: el mapa está en el ordenador del restaurante. Cada impresora usa CP858 y 203 ppp, con perfiles coherentes 80/48 o 58/32. Una sola impresora activa recibe tickets de caja; las comandas admiten varias por estación.

Reclamación transaccional con lease de 60 segundos y secreto separado en `printLeases`. El lease caducado pasa a `uncertain`, sin reenvío. El puente reclama de uno en uno, comprueba hash y tamaño y sincroniza un diario persistente antes de enviar. Cierre TCP remoto limpio permite confirmar envío; timeout, corte o reinicio tras comenzar a escribir quedan inciertos. Perder la respuesta de confirmación solo reintenta confirmar. La proyección visible no contiene bytes ni secretos y dice «Envío confirmado por el puente»; eso no demuestra la salida física de papel. No se ha probado hardware real.

El QR fiscal usa el codificador propio adaptado de carta, modelo 2 V11 M, modo byte, máscara 0 y capacidad de 251 bytes UTF8. Su raster a 203 ppp mide unos 30,5 mm más margen blanco y cabe en 58/80 mm. Enlaces mayores se rechazan; no se omite el QR. Los módulos se contrastan con un generador independiente y se verifica el escaneo del raster por separado. La factura toma QR, leyenda y advertencia del artefacto original de `fiscalRecords` relacionado por `invoices.recordId`, comprobando local y factura; admite artefacto en raíz o en `artifact`. Todo proveedor no válido conserva «no válido para Hacienda».

Los disparadores consumen peticiones durables, recuperan peticiones sin configurar al guardar impresoras y agrupan comandas por pedido, estación, pase, destino y hora de marcha. La reconciliación local permite repetir los procesadores sin crear trabajos duplicados. El cajón exige además `caja.gestionar` y cobro efectivo confirmado, se deduplica por ese cobro y nunca admite copias. Las copias no emiten facturas ni consumen números.

### Integración local de la fase 3

`functions/src/index.ts` exporta las 27 callables de caja, impresión y móvil, las dos lecturas de partes QR, el webhook y sus disparadores. Al cargar conecta móvil a `confirmExternalPayment` e `issuePartInvoice`: no hay un segundo libro de pagos. La pantalla solicita F2 al completar una parte con la casilla de ticket marcada; para F1 se emite primero con los datos del cliente o se desmarca esa casilla. Cobro y emisión son intenciones distintas e idempotentes: fallar la emisión conserva el pago y permite emitir desde Facturar. El backend encola cada factura emitida y el cajón del efectivo en su transacción; el cajón automático también corresponde a cobros de camarero autorizados. La apertura manual por callable sigue exigiendo gestión. Las comandas se encolan al marchar.

Storage no expone originales fiscales, recibos ni bytes de impresión por SDK. El único acceso público de archivos sigue siendo la foto referenciada de carta; el recibo pasa por su callable y token. No se activa TTL sobre reservas de pago ni se cambia su liberación.

El puente conserva TCP 9100 para hardware y admite exclusivamente en demo local el TCP falso loopback 9515 de la fila 5. En las pruebas se usa `127.0.0.2:9515`, separado de Tasks en `127.0.0.1:9515`. No se instala un controlador ni una dependencia. `pnpm seed:caja` prepara configuración fiscal inventada y fondo local sin reiniciar correlativos. Scripts `impresion:puente`, `impresion:reconciliar`, `pago:procesar` y `test:puente` facilitan los procesos existentes.

El recorrido firmado usa un transporte de Checkout inyectado solo en la herramienta de prueba, sin permitir Stripe real desde demo ni modificar la disponibilidad de la interfaz. El webhook HTTP, el ledger, la factura y el recibo son los servicios reales conectados. Todo documento fiscal conserva **no válido para Hacienda**.

### Reparto de implementación entre cuatro agentes

Todos parten de `main` con este contrato integrado y usan su worktree y puertos 1 a 4 de etapa 0. No se delega nada durante la tarea de contrato. Core y firmas quedan congelados; cualquier cambio pasa por el coordinador. Las lecturas/importaciones entre carpetas se permiten; cada archivo tiene un único dueño. El backend implementa primero las firmas de servicio siguientes en `functions/src/fase3/service.ts`, sin que los otros agentes necesiten editarlo:

- `confirmExternalPayment(input: ConfirmedExternalPayment): Promise<{paymentId: string; dueCents: number}>`, valida precio/revisión/reserva contra Checkout guardado y aplica una vez el cobro verificado. Solo importación servidor; no es callable ni acepta que el público marque éxito.
- `issuePartInvoice(input: CallableParsedInput<"emitirFactura">, actorUid: string | null): Promise<CallableOutput<"emitirFactura">>`, misma lógica transaccional e idempotente de la callable; sistema solo para checkout confirmado y destinatario guardado. El worker móvil importa estas dos firmas, nunca copia ni escribe su propio ledger fiscal.
- Backend crea `PrintRequest` de factura/cajón en su transacción con id determinista y `printerId: null` para enrutado por el agente de impresión. No importa código aún inexistente del puente. El agente de impresión es dueño del consumo y resultado de la petición y de la proyección `printStatuses`; un fallo de impresora no revierte un cobro ni factura.

| Agente / rama | Propiedad exclusiva de carpetas y archivos | Entrega y prueba principal |
|---|---|---|
| 1 · Backend de caja y fiscal · `fase3/backend` | `functions/src/fase3/**`, toda integración necesaria de `functions/src/fase2/**` y reservas; `firebase/**`, `tests/rules/fase3*`, `scripts/seed-fase3.ts`, procesador fiscal local | cuenta/reparto/cobros/arqueo/propinas/facturas/Verifactu, servicios anteriores, reglas de todas las colecciones de fase 3, bloqueo con sala y gasto sin duplicación; doble cobro, doble número, concurrencia entre locales/series, anulaciones y rechazo fiscal |
| 2 · Pantalla de caja y cobro · `fase3/caja-web` | `apps/web/src/app/(personal)/panel/caja/**`, `apps/web/src/components/caja/**`, `apps/web/src/lib/caja/**` | abrir/cerrar/arqueo, invitaciones, partes y cobros parciales, facturas y rectificativas, propinas, avisos fiscales y estado de impresora; capturas y pruebas táctiles |
| 3 · Impresión y puente · `fase3/impresion` | `functions/src/fase3-print/**`, `tools/print-bridge/**`, `apps/web/src/app/(personal)/panel/impresoras/**`, `apps/web/src/components/impresion/**`, `apps/web/src/lib/impresion/**`, `scripts/impresion-*.ts` | sus cinco callables, peticiones/cola/lease, ESC/POS real, QR escaneable, comanda/copia/cajón; pruebas sin hardware claramente marcadas y recorrido real cuando haya impresora |
| 4 · Pago móvil y recibo · `fase3/pago-movil` | `functions/src/fase3-mobile/**`, `apps/web/src/app/p/**`, `apps/web/src/app/recibo/**`, `apps/web/src/components/pago-movil/**`, `apps/web/src/lib/pago-movil/**`, `scripts/pago-movil-*.ts` | sus cinco callables, webhook `stripeCuentaWebhook`, reconciliación y entrega, contra servicios de agente 1; firmas buenas/malas/repetidas/tardías, importe incorrecto, token ajeno, sin claves y recibo sin datos ajenos |

No se editan archivos comunes entre agentes: `functions/src/index.ts`, navegación del panel, enlaces desde `/m/**` o para llevar, `package.json`, lockfile, configuración Firebase, CI, `ARQUITECTURA.md`, este contrato y `PLAN.md` los integra el coordinador, salvo `firebase/**` del agente 1 para reglas e índices. Los agentes 3 y 4 exportan un `index.ts` dentro de su carpeta para que el coordinador lo conecte. El agente 1 registra por sí solo sus callables en su `index.ts` de carpeta. No se añaden dependencias sin autorización; codificador QR y drivers deben proponerse con alcance y licencia si no bastan herramientas existentes. El puente local puede necesitar un nuevo comando de workspace: lo integra el coordinador.

Pruebas: cada agente hace lint, tipos, pruebas y build del repo; backend añade reglas y emuladores de su fila, móvil integra las funciones reales del backend una vez disponible, impresión no dice «impreso» sin confirmación. Fusión: backend, impresión, caja web, móvil; coordinador conecta exportaciones/navegación y recorre mesa y para llevar → reparto → cobros mixtos → factura → impresión/recibo → arqueo, además de reintentos, devoluciones y fallos fiscales. No hay emuladores que arrancar en la entrega de core.

Decisiones del usuario pendientes, sin bloquear este contrato local: elegir proveedor fiscal (recomendación: uno con declaración responsable, conservación/exportación y soporte para las tres Haciendas Forales), territorio y tratamiento de anticipos/invitaciones/menús (recomendación: validar la política general implementada con ese proveedor antes del piloto real), impresora y sistema del puente (recomendación: empezar con una ESC/POS de 80 mm, CP858 y 203 ppp), quién cobra/rectifica (recomendación: camarero cobra, encargado rectifica y cierra), y política de propinas (recomendación: reparto por minutos aprobados y pago separado). Fuera de alcance: proveedor productivo/certificación, no VERI*FACTU con eventos y firma propios, conexión bancaria al datáfono, pagos offline fiables, facturación de regímenes no soportados, fichajes y nóminas, RGPD completo y facturación B2B electrónica estructurada. El recibo digital de esta fase no se presenta como cumplimiento de esas otras obligaciones.

## Fase 4 · Personal, inventario y costes

Core entrega esquemas, callables, cálculos y pruebas en `packages/core/src/personal/`, `packages/core/src/inventario/`, `api-personal.ts`, `api-inventario.ts` y `api-fase4.ts`. El backend (`functions/src/fase4/`), las reglas, los índices y el seed ya están hechos (ver «Implementación del backend» más abajo); las pantallas, no. Todo sigue en `demo-llenamos`, con emuladores y sin servicios externos. Se conservan `europe-west1`, ms UTC en core y callables, `Timestamp` en Firestore, **dinero en céntimos enteros y cantidades en unidades enteras (gramos, mililitros, unidades), sin decimales flotantes**, y los cálculos en el servidor. Core no importa Firebase, no lee el reloj (entra como dato) y no añade dependencias. Se inspira en `docs/tareas/comparativa-restaurantos.md` (apartados 11 y 12, filas «3 y 4» y «4» del 24) sin copiar código.

### Módulos, planes y permisos

Dos módulos nuevos en `MODULES`: **`staff`** (Personal: fichaje, cuadrante y horas) e **`inventory`** (Inventario y costes: existencias, escandallos, proveedores y pedidos). Entran en el plan `completo` (que es `MODULES`) y no en `reservas` ni `sala`; LogiQD los enciende o apaga por restaurante con `moduleOverrides` como cualquier otro. Un restaurante migrado con `entitlementVersion` no los hereda: solo manda su proyección `activeModules`. El catálogo comercial provisional de la fase 6 (`provisionalPlanCatalog`) **no se toca**: en qué plan comercial van es una duda del propietario. `inventory` y `staff` no dependen de `floor` ni de `pos` para guardar datos, pero el descuento al vender solo ocurre si hay pedidos (`floor`), y repartir propinas por horas necesita `pos` además de `staff`. Apagar un módulo nunca borra el historial.

Nueve permisos nuevos en `roles.ts`, que repiten la interfaz, las funciones y las reglas:

| Permiso | owner | manager | waiter | kitchen | bar | Módulo |
|---|---|---|---|---|---|---|
| `fichaje.registrar` (fichar uno mismo y ver sus propios fichajes), `cuadrante.ver` (ver el cuadrante publicado) | ✓ | ✓ | ✓ | ✓ | ✓ | staff |
| `personal.gestionar` (cuadrante, horas del equipo, correcciones, olvidados, puesto de fichaje, PIN, ajustes) | ✓ | ✓ | | | | staff |
| `inventario.ver` (existencias y avisos, sin costes), `inventario.mermar` (registrar merma con motivo) | ✓ | ✓ | | ✓ | ✓ | inventory |
| `inventario.gestionar` (ingredientes, ajustes, recuentos, ajustes del módulo) | ✓ | ✓ | | | | inventory |
| `costes.ver` (costes, movimientos con valor, márgenes), `escandallos.editar` (recetas) | ✓ | ✓ | | | | inventory |
| `compras.gestionar` (proveedores, formatos, pedidos, recepción) | ✓ | ✓ | | | | inventory |

Cocina y barra ven cuánto hay y avisan de lo que falta, pero **nunca ven costes**: los costes viven en documentos aparte (`ingredientCosts`, `stockMovements`, `recipes`, `lineCosts`) que solo leen owner y manager. El camarero ficha y ve su cuadrante; no entra en inventario. `FASE4_ACCESS` es la fuente de verdad del permiso y los módulos base de cada callable; `informeHoras` es `per_target` (ver las propias horas basta con `fichaje.registrar`; las de otra persona o todas, `personal.gestionar`).

### Datos y autores de las escrituras

Rutas bajo `restaurants/{rid}`; las de local bajo `restaurants/{rid}/locations/{lid}`. **Ningún documento de la fase admite escritura directa de cliente.** Las callables y procesos toman el autor de Auth (o lo dejan nulo si actúa el sistema), comprueban miembro activo y `locationIds`, y guardan `createdAt`, `updatedAt` y `updatedBy` del servidor. Core lee `Timestamp` y ofrece adaptadores `xxxForWrite` con conversor recibido.

```
restaurants/{rid}
  staffClockLocks/{uid}          locationId, entryId                    ← solo servidor: un fichaje abierto por persona en todo el restaurante
  locations/{lid}
    settings/staff               StaffSettings
    settings/inventory           InventorySettings
    timeEntries/{entryId}        TimeEntry
    timeEntryEvents/{eventId}    TimeEntryEvent                          ← inmutable (auditoría de cada cambio)
    staffPins/{uid}              PinRecord                               ← solo servidor, secreto
    shifts/{shiftId}             StaffShift
    staffRequests/{hash}         requestId, actor, huella de la entrada, resultado   ← solo servidor, idempotencia
    ingredients/{ingredientId}   Ingredient (cantidad en unidad base, sin costes)
    ingredientCosts/{ingredientId}  IngredientCost (valor total y último coste)
    stockMovements/{movementId}  StockMovement                           ← libro inmutable
    recipes/{recipeId}           Recipe
      versions/{n}               RecipeVersion                           ← inmutable
    lineCosts/{lineId}           LineCost (coste y precio congelados de cada línea vendida)
    stockCounts/{countId}        StockCount
    stockAlerts/{ingredientId}   StockAlert (un aviso vivo por ingrediente)
    suppliers/{supplierId}       Supplier
    supplierItems/{itemId}       SupplierItem (formato de un proveedor para un ingrediente)
    purchaseOrders/{orderId}     PurchaseOrder
    purchaseReferences/{reference}  orderId                             ← solo servidor, referencia única por local
    goodsReceipts/{receiptId}    GoodsReceipt                            ← albarán inmutable
    inventoryRequests/{hash}     requestId, actor, huella de la entrada, resultado   ← solo servidor, idempotencia
```

Toda mutación lleva `requestId`. Una llamada repetida con el mismo actor, ruta y `requestId` y la misma entrada devuelve el resultado original sin repetir efectos; con otra entrada, `already-exists`. Errores: `permission-denied` (permiso, módulo o local), `failed-precondition` (revisión o estado obsoletos, fichaje en estado incompatible), `not-found`, `invalid-argument`, `already-exists`, todos con mensaje en castellano para enseñar.

### Fichaje y horas

Un **fichaje** (`TimeEntry`) es un periodo de trabajo con entrada, salida opcional y hasta 20 pausas. Pertenece al día local de su entrada (`date`, en la zona del restaurante) aunque cruce la medianoche. Reglas:

- **El reloj es el del servidor.** `fichar` no recibe hora: guarda `now` truncado al minuto (`truncateToMinute`), así los minutos son exactos. Solo `crearFichajeManual`, `corregirFichaje` y `cerrarFichajeOlvidado` (encargado, con motivo) escriben horas, y `validateEntryTimes` las comprueba: no futuro, salida posterior a la entrada, máximo 16 horas, pausas dentro y sin solapes, sin solape con otros fichajes de esa persona.
- **Una persona, un fichaje abierto en todo el restaurante** (`staffClockLocks/{uid}`, en la misma transacción). Acciones: `in`, `break_start`, `break_end`, `out` (`applyClockAction`). Salir con una pausa abierta la cierra a esa hora. Repetir la misma intención con el mismo `requestId` devuelve el resultado original (no «ya tienes el fichaje abierto»).
- **Tiempo trabajado** (`entryMinutes`): bruto menos pausas (las pausas se descuentan salvo `breaksPaid: true`), con las pausas recortadas al fichaje y fundidas si se solapan; luego redondeo de los ajustes (`roundingMinutes` 0, 5, 10 o 15, al más cercano con la mitad hacia arriba o siempre hacia abajo). Los minutos y el redondeo se **guardan al cerrar** (`workedMinutes`, `breakMinutes`); un cambio posterior de ajustes no reescribe horas pasadas.
- **Medianoche y cambio de hora.** `minutesByLocalDay` parte los tramos de trabajo en las medianoches locales y reparte los minutos redondeados entre los días con restos mayores, de modo que la suma por día es exactamente el total del fichaje (21:00 a 02:00 con pausa cuenta en dos días). Con el retraso de octubre una noche de 22:00 a 06:00 son 9 horas reales; con el adelanto de marzo, 7.
- **Fichajes olvidados.** El proceso `revisarFichajesAbiertos` marca `forgotten: true` en los abiertos que pasan `forgottenAfterMinutes` (720 por defecto). Mientras sigue abierto no suma horas (`hoursReport` los cuenta aparte y da un `provisionalMinutes` orientativo), y **no se puede cerrar fichando**: lo cierra un encargado con `cerrarFichajeOlvidado` (hora de salida explícita, motivo; `suggestedCloseAt` propone el final del turno planificado) o lo anula. Un fichaje cerrado por un encargado queda con `needsReview: true`.
- **Auditoría.** Cada fichaje, pausa, creación manual, corrección, cierre de olvidado y anulación escribe un `TimeEntryEvent` inmutable con quién, cuándo, la foto de antes y de después (`snapshotOf`) y el motivo, que es obligatorio en todo lo que hace un encargado. `anularFichaje` pone `status: "voided"`; nada se borra. La actividad (`activity`) recoge solo lo que hace un encargado (`staff.entry_created`, `entry_corrected`, `entry_closed`, `entry_voided`, `shift_saved`, `shift_deleted`, `schedule_published`, `settings_saved`, `pin_saved`) y el aviso de olvidado (`staff.entry_forgotten`), no cada fichaje propio, que ya está en `timeEntryEvents`.
- **Móvil o tableta del local.** Desde el móvil cada persona ficha con su sesión (`fichar`). La tableta del local usa `ficharEnPuesto`: sesión de un encargado (`personal.gestionar`) más el **PIN de 4 a 6 cifras** de la persona (`guardarPinFichaje`, y `kioskEnabled` en `settings/staff`). El PIN se guarda con sal y huella SHA-256 (`staffPins`), cinco fallos seguidos lo bloquean cinco minutos (`checkPin`). Es una comodidad del puesto, no una barrera fuerte: por eso el puesto exige además la sesión del encargado. El fichaje queda con `source: "kiosk"` y el uid del encargado como autor del evento.
- **Sin conexión.** Fichar necesita el servidor: no entra en la cola local de la fase 6 y no se fabrican horas en el dispositivo. Si falta conexión, el encargado crea el fichaje a mano después.
- **Conservación.** El registro de jornada es una obligación laboral con plazo de conservación (cuatro años, a confirmar con el asesor laboral). La purga de datos de la fase 6 no debe borrar fichajes dentro de ese plazo; los esquemas de privacidad deberán marcarlo al implementar. Llenamos facilita el registro, no certifica el cumplimiento laboral ni conoce el convenio de cada restaurante.

### Cuadrante

`StaffShift` es un turno de una persona con inicio y fin (ms), puesto escrito por el encargado y nota. Pertenece al día local en que empieza y a la semana (de lunes a domingo) de ese día (`shiftPlacement`). Los turnos son **borrador** hasta `publicarCuadrante` de la semana; los publicados los ve todo el personal con `cuadrante.ver` y los borradores solo `personal.gestionar`. Publicar o despublicar cambia el `status` de los turnos de la semana y sube su revisión; no envía mensajes (los avisos al personal quedan fuera de esta fase).

`guardarTurno` rechaza con `failed-precondition` los turnos que se pisan con otro de la misma persona (`findShiftConflicts`) y devuelve avisos orientativos (`scheduleWarnings`): descanso menor que `minRestMinutes` (12 horas por defecto) y horas planificadas por semana por encima de `maxWeeklyMinutes` (40 por defecto). Son avisos, no bloqueos, y no son asesoría laboral. `copiarSemanaCuadrante` copia los turnos de una semana a otra como borradores conservando la hora de pared (`copyWeek`); los turnos cuya hora no existe en el destino (adelanto de marzo) se devuelven en `skipped`. `planVsReal` compara cada turno con el fichaje que empieza desde dos horas antes (a su hora, tarde, no ha fichado, aún no toca) con la tolerancia de los ajustes. No hay vacaciones, bajas ni intercambio de turnos en esta fase.

### Propinas por horas fichadas (fase 3)

La fase 3 dejó `repartirPropinas` con minutos aprobados a mano y `distributeTips` por restos mayores. **Su firma no cambia.** La fase 4 añade la callable `horasParaPropinas({ cashSessionId })` (permiso `caja.gestionar`, módulos `staff` y `pos`), que calcula con `tipHoursForWindow` los minutos fichados por persona dentro de la caja (de su apertura a su cierre, o a ahora si sigue abierta): suma los tramos de trabajo que caen en la ventana, sin pausas si no se pagan y sin redondeo, y devuelve `{ uid, minutes }[]` listo para `repartirPropinas`. Un fichaje abierto cuenta hasta el final de la ventana; si está **olvidado** no se cuenta y esa persona sale en `incomplete` para que el encargado lo corrija antes de repartir. La pantalla de caja precarga esas horas, las deja editar y el encargado las aprueba al repartir. Si no hay módulo `staff`, sigue valiendo la entrada manual de la fase 3.

### Almacén: unidades, existencias y coste

- **Cantidades enteras en unidad base** (`g`, `ml`, `u`). Se pueden escribir en kg, cl o l y se convierten con `toBase` o `parseQuantity` («1,5 kg» da 1500 g; «0,5 g» se rechaza por no salir exacto). No se mezclan familias (masa, volumen, unidades): pasar kilos a litros exige una densidad que no se inventa. `formatQuantity` enseña 1250 g como «1,25 kg».
- **Ingrediente** (`Ingredient`): nombre, unidad base (no cambia con movimientos), categoría, `minQuantity` (aviso; 0 = sin aviso), `targetQuantity` (hasta dónde reponer; sin él, el doble del mínimo), `active` y `quantity` actual (solo servidor, puede quedar negativa). Su valor y último coste viven en `ingredientCosts`.
- **Coste medio ponderado exacto** (`coste.ts`). Cada ingrediente guarda cantidad y valor total en céntimos. Al entrar stock (`addStock`) suma su valor; al salir (`removeStock`) resta el valor proporcional con redondeo y **el último consumo se lleva el resto exacto**, así el valor nunca se desvía por redondeos (si se consume en trozos que no dividen, lo consumido suma justo el valor inicial). Los costes van **sin IVA** (el IVA soportado es deducible; los precios de carta son con IVA y se pasan a base con `netOfGross`).
- **Sin existencias no se bloquea la venta.** Si se consume más de lo que hay (el almacén rara vez está perfecto), la cantidad queda negativa y lo que faltaba se valora al último coste conocido (`shortfall`); sin coste conocido esas unidades valen cero y el coste de la línea queda `complete: false`. La recepción siguiente cubre primero el déficit y solo valora lo que sobra. El aviso de stock negativo lo hace visible.
- **Libro de movimientos** (`StockMovement`): `opening`, `receipt`, `sale`, `sale_reversal`, `waste`, `supplier_return`, `count_adjust`, `adjustment`. Inmutable y de solo añadir; las correcciones son otro movimiento. Cada uno guarda cantidad con signo, valor con el mismo signo, cantidad resultante, autor, motivo y su referencia (línea, albarán o recuento). Todo cambio de existencias, su movimiento, el valor, el aviso y la actividad ocurren en **una transacción**. Los ids de movimientos automáticos son deterministas (`consumptionMovementId`, `{lineId}.{ciclo}.c|r.{ingredientId}`) para que un reintento no duplique.
- **Merma** (`registrarMerma`, `inventario.mermar`): cantidad entera y motivo de lista (caducado, estropeado, roto o derramado, error de cocina, comida del personal, otro) más texto opcional. Sale al coste medio. La respuesta no lleva valor: lo ve quien tiene `costes.ver`. Devolver mercancía al proveedor y ajustar a mano (`ajustarStock`, `inventario.gestionar`) exigen motivo; un ajuste al alza se valora al coste medio (o al último coste).
- **Fuera de alcance: lotes y caducidades.** No hay FEFO ni trazabilidad por lote; es una decisión consciente (ver la tabla de dudas). La caducidad se controla con la merma y el recuento.

### Escandallos y margen

- **Receta** (`Recipe`): ligada a un plato (`itemId`) y opcionalmente a una variante (`variantId`); la de la variante gana y, si no existe, vale la común sin variante (`resolveRecipe`). Lleva líneas `{ ingredientId, quantity netas por ración en unidad base, yieldBp }` (el rendimiento en puntos básicos: 200 g netos con 80 % piden 250 g, redondeo siempre hacia arriba en `requiredQuantity`), líneas extra por **opción de la carta** elegida (`optionLines`) y, alternativamente, un `manualCostCents` por ración si no se detallan ingredientes (no se puede usar con líneas). No hay elaboraciones intermedias (salsas o fondos como receta de otra receta): se compran o se describen directamente en el plato.
- **Versionado.** `version` sube solo si cambia lo que consume o cuesta (`nextRecipeVersion`: ingredientes, extras, rendimiento o coste manual; no el nombre ni `active`). Cada versión queda en `recipes/{id}/versions/{n}`, inmutable. Un plato sin receta no consume ni da error.
- **Coste teórico** (`recipeCost`): suma, por ración, el coste de cada ingrediente (coste medio actual, redondeado por ingrediente). Si falta el coste de alguno, `complete: false` y `missing` lo lista. `guardarReceta` lo devuelve.
- **Margen** (`dishMargin`): sobre el precio sin IVA, en puntos básicos (6500 = 65 %): margen en céntimos, `marginBp` y `foodCostBp`. Precio de carta con IVA incluido y tipo de IVA del plato (`TaxRate`).
- **Coste histórico.** Cada línea vendida con consumo guarda en `lineCosts/{lineId}` su cantidad, receta y versión, **coste y precio de ese momento** (`costCents`, `grossCents`, `taxRate`) y su estado. Cambiar después una receta o un precio de proveedor no toca lo ya vendido. `summarizeDishMargins` resume por plato y variante: unidades, unidades con coste, ingreso sin IVA, coste, pérdida por anulaciones después de preparar y margen. Los platos dentro de un menú del día se separan (`inMenu`): su ingreso está en el precio del menú y no se compara con su coste suelto; el margen del menú se analizará en la fase 5. No prorratea invitaciones ni descuentos de caja.
- `margenPlatos({ from, to })` (`costes.ver`) devuelve el histórico del periodo y el teórico de hoy por receta, con el precio de carta actual.

### Descuento al vender, al anular y por merma

**Decisión: el almacén se descuenta cuando la línea marcha** (entra en `fired`), no al pedir ni al servir. Antes de marchar (`pending`, `held`) no se consume; así un pedido por aceptar o una comida retenida no gasta stock. El objetivo de cada línea se calcula **solo con su estado actual y su historial** (`lineConsumptionTarget`), no con eventos, así un disparador repetido, perdido o fuera de orden no duplica ni olvida nada:

| Situación de la línea | Objetivo | Efecto en el almacén |
|---|---|---|
| `pending`, `held` (nunca marchada) | reversed | nada |
| `fired`, `preparing`, `ready`, `served` | consumed | descuenta los ingredientes de su receta |
| `held` tras desmarcar una marchada | reversed | devuelve lo descontado (cantidad y valor exactos) |
| `cancelled` desde `fired`, sin haber empezado a prepararla | reversed | devuelve lo descontado |
| `cancelled` después de `preparing`, `ready` o `served` | wasted | **no devuelve**: es merma; el coste queda en `lineCosts` como pérdida |

`consumptionSteps(estadoActual, objetivo)` da los pasos (`consume`, `reverse`, `mark_wasted`) y `wasted` y `no_recipe` no se mueven. Una línea que se marcha de nuevo tras desmarcarla abre un nuevo ciclo (`cycle`). Las necesidades salen de `recipeRequirements` con la cantidad de la línea y los extras elegidos (`modifiers[].optionId`); un plato de un menú del día (`menu_component`) consume como plato propio, la línea `menu` no consume. **No es retroactivo:** la receta se resuelve al marchar; si no hay receta, `lineCosts` queda en `no_recipe` y esa línea no se vuelve a evaluar. `planConsumption` y `planReversal` son puras: el proceso solo persiste su resultado.

**Coexistencia con las raciones de la fase 2 (`MenuItem.portions`).** Son dos cosas distintas y conviven sin tocarse. El contador diario de raciones sigue siendo **manual** (`guardarRaciones`), descuenta al pedir y es **lo único que bloquea la venta** («quedan 12 paellas»). El almacén no bloquea nada, solo informa, y **nunca escribe `portions`** ni marca agotados. Anular o rechazar sigue sin devolver raciones (regla de la fase 2) y, aparte, el almacén devuelve o pierde según la tabla. `portionsPossible` calcula cuántas raciones se pueden hacer con lo que hay y es solo un dato para que el cocinero rellene el contador a mano. Pasar a agotado automático por falta de ingredientes queda como duda.

### Recuento, mínimos y avisos

- **Recuento** (`StockCount`, `iniciarRecuento`, `guardarRecuento`, `aplicarRecuento`, `cancelarRecuento`): se cuenta mientras el servicio sigue. Cada línea guarda lo contado y **cuándo** (`countedAt`); al aplicar, la diferencia es lo contado menos lo que el libro decía en ese instante (cantidad actual menos lo movido desde `countedAt`, `countDifference`). Una diferencia positiva entra al coste medio y una negativa sale valorada como pérdida, cada una como movimiento `count_adjust`. Las líneas sin contar no se tocan. Un recuento aplicado o cancelado no se reabre; aplicarlo dos veces devuelve el resultado original.
- **Avisos** (`StockAlert`, un aviso vivo por ingrediente): niveles `low` (en el mínimo o por debajo), `out` (cero) y `negative`. Se abre al bajar del mínimo, vuelve a avisar solo si empeora, y se resuelve al volver por encima (`alertAction`). Existen solo con `lowStockAlerts` activado y mínimo mayor que cero (`alertsApply`). Se actualizan en la misma transacción que el movimiento que los provoca y generan actividad `stock.low` al abrirse o empeorar. `reconocerAvisoStock` (`inventario.ver`) lo marca como visto sin silenciar un empeoramiento. El aviso es un documento visible en el panel; **no envía notificaciones push** en esta fase.

### Proveedores y pedidos

- **Proveedor** (`Supplier`): contacto, plazo en días, pedido mínimo sin IVA y notas. **Formato** (`SupplierItem`): un ingrediente que vende un proveedor en un formato concreto («Garrafa 5 l» = 5000 ml, precio sin IVA); puede marcarse `preferred`. El último precio pagado lo escribe la recepción.
- **Pedido** (`PurchaseOrder`): borrador, enviado, recibido en parte, recibido, anulado o cerrado sin completar. Cada línea congela el formato, sus unidades base y el precio con que se pidió; el servidor pone el precio desde el formato guardado, nunca desde la entrada. **Llenamos no envía el pedido al proveedor**: «enviado» significa que el encargado lo ha hecho por teléfono, WhatsApp o correo; no se simula ningún envío. La referencia es de seis caracteres como las de reservas, única por local (`purchaseReferences`).
- **Recepción parcial** (`recibirPedidoProveedor`, `planReceipt`): un albarán (`GoodsReceipt`, inmutable) con los formatos recibidos y el **precio del albarán**, que entra en el almacén como movimiento `receipt` al precio realmente pagado y actualiza el coste medio y el último coste. El pedido pasa a «recibido en parte» o a «recibido» según lo pendiente. Se admite recibir de más (se marca `exceeded`) y registrar un precio distinto del último (se devuelve en `priceChanges` con la variación en puntos básicos para revisar). También se admite una compra directa sin pedido, con un formato activo del proveedor. Un pedido con recepciones no se anula: se cierra sin completar con motivo (`checkPurchaseTransition`). Una recepción equivocada se corrige con un ajuste o una devolución a proveedor, no se edita.
- **Sugerencias** (`sugerirPedidos`, `suggestOrders`): para cada ingrediente activo con mínimo, si `existencias + ya pedido` está en el mínimo o por debajo, propone formatos enteros (hacia arriba) hasta el objetivo, del formato preferido o el más barato por unidad base, agrupado por proveedor y avisando si no llega al pedido mínimo. Los ingredientes sin formato activo salen aparte. Es una propuesta: el encargado crea el pedido.

### Callables (contrato para el backend)

31 nombres, región `europe-west1`, integrados en `CALLABLES`, `CALLABLE_SCHEMAS` y `CallableInput/ParsedInput/Output` desde `api-fase4.ts`. **S** = `{ restaurantId, locationId }`; **M** = S más `requestId`. Todos exigen sesión de Auth, miembro activo y acceso al local; los módulos y el permiso base están en `FASE4_ACCESS`. Ninguna entrada trae costes, valores, totales, autor ni estados.

| Callable | Entrada adicional | Salida | Permiso y módulo |
|---|---|---|---|
| guardarConfiguracionPersonal | M, settings | ok | personal.gestionar, staff |
| fichar | M, action in/break_start/break_end/out, note? | entryId, state, at, workedMinutes\|null | fichaje.registrar, staff |
| ficharEnPuesto | M, uid, pin, action | igual que fichar | personal.gestionar, staff (y `kioskEnabled`) |
| guardarPinFichaje | M, uid, pin\|null | ok | personal.gestionar, staff |
| crearFichajeManual | M, uid, startAt, endAt, breaks[], reason | entryId, workedMinutes | personal.gestionar, staff |
| corregirFichaje | M, entryId, expectedRevision, startAt, endAt, breaks[], reason | revision, workedMinutes | personal.gestionar, staff |
| cerrarFichajeOlvidado | M, entryId, expectedRevision, endAt, reason | revision, workedMinutes | personal.gestionar, staff |
| anularFichaje | M, entryId, expectedRevision, reason | ok | personal.gestionar, staff |
| informeHoras | S, from, to, uid\|null | rows[] (minutos, abiertos, olvidados, por día) | per_target, staff |
| guardarTurno | M, shiftId\|null, expectedRevision\|null, shift | shiftId, revision, warnings[] | personal.gestionar, staff |
| borrarTurno | M, shiftId, expectedRevision | ok | personal.gestionar, staff |
| publicarCuadrante | M, weekStart, publish | shifts, warnings[] | personal.gestionar, staff |
| copiarSemanaCuadrante | M, fromWeekStart, toWeekStart | copied, skipped[] | personal.gestionar, staff |
| horasParaPropinas | S, cashSessionId | hours[], incomplete[], windowStart, windowEnd | caja.gestionar, staff y pos |
| guardarConfiguracionInventario | M, settings | ok | inventario.gestionar, inventory |
| guardarIngrediente | M, ingredientId\|null, expectedRevision\|null, ingredient, opening\|null | ingredientId, revision | inventario.gestionar, inventory |
| guardarReceta | M, recipeId\|null, expectedVersion\|null, recipe | recipeId, version, cost | escandallos.editar, inventory |
| registrarMerma | M, ingredientId, quantity, wasteReason, reason? | movementId, quantityAfter | inventario.mermar, inventory |
| ajustarStock | M, ingredientId, kind adjustment/supplier_return, quantity, reason | movementId, quantityAfter | inventario.gestionar, inventory |
| iniciarRecuento | M, name, ingredientIds\|null | countId, revision, ingredients | inventario.gestionar, inventory |
| guardarRecuento | M, countId, expectedRevision, lines[] | revision | inventario.gestionar, inventory |
| aplicarRecuento | M, countId, expectedRevision | adjusted[], unchanged, uncounted | inventario.gestionar, inventory |
| cancelarRecuento | M, countId, expectedRevision | ok | inventario.gestionar, inventory |
| reconocerAvisoStock | M, ingredientId | alert | inventario.ver, inventory |
| guardarProveedor | M, supplierId\|null, supplier | supplierId | compras.gestionar, inventory |
| guardarFormatoProveedor | M, itemId\|null, item | itemId | compras.gestionar, inventory |
| guardarPedidoProveedor | M, orderId\|null, expectedRevision\|null, supplierId, lines[{supplierItemId, formats}], expectedOn, notes | orderId, reference, revision, totalCents | compras.gestionar, inventory |
| cambiarEstadoPedidoProveedor | M, orderId, expectedRevision, to sent/cancelled/closed, reason? | revision, status | compras.gestionar, inventory |
| recibirPedidoProveedor | M, supplierId, purchaseOrderId\|null, expectedRevision\|null, deliveryNote?, lines[{supplierItemId, receivedFormats, priceCents}] | receiptId, totalCents, orderStatus, pending[], exceeded[], priceChanges[] | compras.gestionar, inventory |
| sugerirPedidos | S | orders[], withoutSupplier[] | compras.gestionar, inventory |
| margenPlatos | S, from, to | sold[], theoretical[], generatedAt | costes.ver, inventory |

Las lecturas de listas y fichas (fichajes propios, cuadrante, existencias, avisos) las hace el SDK de cliente con las reglas de abajo; las callables son para escribir y para los cálculos que deben ser del servidor. Para `guardarIngrediente`, `opening` fija las existencias iniciales solo al crear. `guardarPedidoProveedor` solo guarda borradores.

### Estados y transiciones

| Entidad | Transiciones |
|---|---|
| TimeEntry | open → closed (salida) o voided; closed → voided; closed se corrige con `corregirFichaje` (nueva revisión y evento), nunca se reabre; `forgotten` solo lo pone el proceso y lo limpia cerrar o anular |
| Pausa | abierta → cerrada (vuelta o salida); una sola abierta a la vez |
| StaffShift | draft ↔ published por semana; se edita en cualquiera de los dos estados con revisión |
| StockCount | draft → applied o cancelled, finales |
| StockAlert | open → acknowledged; open o acknowledged → resolved; resolved → open al volver a bajar; empeorar reabre un reconocido |
| LineCost | none → consumed → reversed ↔ consumed (nuevo ciclo) → wasted (final); no_recipe final |
| PurchaseOrder | draft → sent o cancelled; sent → partially_received, received o cancelled (sin recepciones); partially_received → received o closed; received, cancelled y closed finales |
| GoodsReceipt, StockMovement, TimeEntryEvent, RecipeVersion | solo creación |

### Reglas de Firestore y consultas

Todas exigen miembro activo, acceso al local y módulo, y rechazan escrituras de cliente. Firestore no filtra: las consultas piden siempre los filtros de la regla.

| Ruta | Lectura desde el SDK cliente |
|---|---|
| settings/staff | personal.gestionar, staff |
| timeEntries | personal.gestionar: todos; fichaje.registrar: solo `uid == request.auth.uid`; staff |
| timeEntryEvents | personal.gestionar, staff |
| shifts | personal.gestionar: todos; cuadrante.ver: solo `status == "published"`; staff |
| settings/inventory, stockCounts | inventario.gestionar, inventory |
| ingredients, stockAlerts | inventario.ver, inventory |
| ingredientCosts, stockMovements, recipes y versions, lineCosts | costes.ver, inventory |
| suppliers, supplierItems, purchaseOrders, goodsReceipts | compras.gestionar, inventory |
| staffClockLocks, staffPins, staffRequests, purchaseReferences, inventoryRequests | nadie desde el SDK cliente |

Índices que habrá que añadir: fichajes por uid y fecha, por estado y por `forgotten`, turnos por semana y estado, por uid y hora, movimientos por ingrediente y hora, por línea y por recuento, `lineCosts` por fecha, pedidos por proveedor y estado, albaranes por proveedor y hora. Pruebas de reglas positivas y negativas por rol, módulo y local; la cocina no debe poder leer `ingredientCosts`.

### Procesos

| Proceso | Cuándo y garantía |
|---|---|
| `consumirPorLinea` | disparador sobre `orderLines/{lineId}`; lee la línea, su historial y `lineCosts`, calcula el objetivo y aplica los pasos en una transacción (movimientos, existencias, valor, avisos, `lineCosts`). Solo con `consumeOnSale` y módulo `inventory`. Idempotente por diseño: ids deterministas y objetivo calculado del estado. Fuera de la transacción de sala a propósito: un fallo de inventario nunca bloquea un pedido; lo recoge la reconciliación |
| `reconciliarConsumos` | cada hora; revisa las líneas de las últimas 48 horas cuyo `lineCosts` no cuadre con su objetivo y las arregla con los mismos pasos |
| `revisarFichajesAbiertos` | cada 15 minutos; marca `forgotten` (`findForgottenEntries`) y escribe una actividad para el encargado; no cierra nada ni inventa horas |
| Avisos de stock | no hay proceso propio: se actualizan en la misma transacción que cada movimiento (`alertAction`) |

Un ingrediente muy usado recibe muchas escrituras seguidas (cada línea que lo consume). A la escala de un restaurante basta con reintentar la transacción; si algún día hiciera falta, se repartirían contadores. No hay lotes ni caducidades.

### Core entregado y límites de la fase

`personal/`: ajustes, fichaje, auditoría, turnos, PIN y adaptadores (`modelo.ts`); minutos, pausas, redondeo, reparto por día, informe, olvidados y propinas (`horas.ts`); acciones de fichar, validación y PIN (`fichaje.ts`); semanas, conflictos, avisos, copia y comparación con lo fichado (`cuadrante.ts`). `inventario/`: unidades y cantidades (`unidades.ts`), coste medio exacto (`coste.ts`), documentos (`modelo.ts`), escandallos y margen (`recetas.ts`), consumo (`consumo.ts`), recuento (`recuento.ts`), avisos (`avisos.ts`), margen histórico (`margenes.ts`) y compras (`compras.ts`). Todo exportado desde `@llenamos/core` con sus pruebas: horas y pausas cruzando medianoche y cambios de hora, redondeos, olvidados, PIN, propinas por horas, conflictos y copia de cuadrante, conversión de unidades y formatos, coste medio con enteros y con stock negativo, coste por receta con rendimiento y extras, descuento al vender, al anular y al desmarcar, merma, recuento con ventas durante el conteo, mínimos y avisos, y pedido con recepción parcial, exceso y cambio de precio.

No se hace en la fase 4: lotes y caducidades, elaboraciones intermedias, vacaciones, bajas y nóminas, intercambio de turnos, avisos push de stock o de cuadrante, envío real de pedidos a proveedores, lectura de albaranes o facturas de proveedor, inventario por varios almacenes, fichaje sin conexión, geolocalización o reconocimiento facial en el fichaje, prorrateo de descuentos de caja en el margen, ni margen de menús del día (fase 5).

### Pantallas de inventario y escandallos (web)

Implementadas en `apps/web` sin cambiar core ni firmas. Rutas y permisos (el módulo `inventory` siempre): `/panel/inventario` (existencias, avisos y merma, `inventario.ver`; la merma pide `inventario.mermar`), `/panel/inventario/ingredientes`, `/recuento` y `/ajustes` (`inventario.gestionar`), `/panel/inventario/movimientos` (`costes.ver`) y `/panel/escandallos` (`costes.ver`; editar recetas pide `escandallos.editar`). Cocina y barra solo ven la primera, sin ningún importe y sin pedir `ingredientCosts`. Escrituras: solo por callable, con un `requestId` que se conserva mientras no se sepa si el envío llegó. Lecturas: SDK de cliente con los filtros de las reglas. El coste teórico y el margen vendido salen de `margenPlatos`; la vista previa de coste al editar una receta y la de reconciliación al revisar un recuento reutilizan `recipeCost`, `dishMargin` y `countDifference` de core, sin reescribirlos. Una variante sin receta propia edita la receta común del plato (o crea la suya).

### Implementación de la web de personal (fichaje y cuadrante)

Pantallas en `apps/web` (carpetas `components/personal`, `lib/personal` y las rutas de abajo). Usan `CALLABLE_SCHEMAS_FASE4` y la lógica de core (`clockState`, `entryMinutes`, `scheduleWarnings`, `planVsReal`, `suggestedCloseAt`, `plannedMinutesByUid`); no duplican cálculos de horas. **No se ha cambiado `packages/core`.**

| Ruta | Quién | Qué hace |
|---|---|---|
| `/panel/fichaje` | `fichaje.registrar` y módulo `staff` | Fichar entrada, pausa, vuelta y salida desde el móvil (botones de 80 px; la salida pide confirmación). Marcas de hoy, turnos publicados de la semana, horas fichadas de la semana (`informeHoras` propio) y últimos fichajes. Un fichaje olvidado no ofrece botones: dice que lo cierre un encargado. |
| `/panel/fichaje/puesto` | `personal.gestionar` y `kioskEnabled` | Puesto de tableta: rejilla del equipo con su estado en directo, teclado de PIN de 64 px y acción según el estado (`ficharEnPuesto`). El diálogo se cierra solo a los 30 s sin tocar nada y a los 3,5 s de fichar. Con el puesto apagado, ofrece encenderlo. |
| `/panel/personal` | `personal.gestionar` | Hoy: quién está dentro, en pausa u olvidado, y los turnos de hoy frente a lo fichado (`planVsReal`). |
| `/panel/personal/horas` | `personal.gestionar` | Hoja de horas por semana o mes y por persona (`informeHoras`), lista de fichajes con corregir, cerrar, anular y ver historial (`timeEntryEvents`), fichaje a mano y sección de olvidados. Todo cambio pide motivo; el formulario enseña la previsión con `entryMinutes` y el servidor vuelve a calcular. |
| `/panel/personal/cuadrante` | `personal.gestionar` | Rejilla persona por día (lista por día en el móvil), avisos de descanso y horas con `scheduleWarnings`, copiar la semana anterior, publicar o pasar a borrador y comparación con lo fichado. |
| `/panel/personal/ajustes` | `personal.gestionar` | `StaffSettings` y PIN de cada persona (no se puede ver, solo poner, cambiar o quitar). |

Decisiones de la interfaz:

- **Horas escritas en orden.** Entrada, pausas y salida se escriben como `20:30` y cada hora siguiente es la primera vez que el reloj marca esa hora desde la anterior: una salida `02:10` tras una entrada `20:00` es del día siguiente. El cambio de hora de marzo (la 02:30 no existe) se avisa; en octubre se toma la primera aparición. Está en `lib/personal/modelo.ts` con pruebas.
- **Idempotencia.** `useAccionPersonal` pone un `requestId` por intención y lo repite si la respuesta no llegó (error no definitivo); un doble toque no lanza dos llamadas. Fichar sin conexión no se hace: se dice.
- **Lecturas.** Las consultas llevan el filtro que piden las reglas (`uid` propio en fichajes, `status == "published"` para el camarero en turnos). El camarero no lee `settings/staff`.
- **Cerrar un olvidado** propone la salida del turno de ese día si existe (`suggestedCloseAt`); si la hora choca con otro fichaje de esa persona, el servidor lo rechaza y la pantalla enseña el motivo.
- **Cuadrante.** Un turno nuevo en una semana ya publicada nace como borrador (lo hace `guardarTurno`): la pantalla lo marca con borde punteado y el botón pasa a «Publicar N nuevos». Publicar no envía avisos al equipo y la pantalla lo dice.

Entradas de menú que añade el coordinador: `Fichaje` (`/panel/fichaje`, `fichaje.registrar`, módulo `staff`) y `Personal` (`/panel/personal`, `personal.gestionar`, módulo `staff`).

### Integración de la fase 4 con caja, cocina y barra

- **Propinas por horas.** `Propinas` (en `components/caja/Turno.tsx`) llama a `horasParaPropinas` solo si el restaurante tiene el módulo `staff` (`useHorasParaPropinas`, en `lib/personal/datos.ts`) y **precarga** los minutos fichados en los campos de siempre; el encargado los puede cambiar y `repartirPropinas` sigue recibiendo `hours` con la misma firma. Los fichajes olvidados (`incomplete`) se avisan y no cuentan hasta que un encargado los cierre; si nadie fichó en esa caja o falla la lectura se dice y el reparto manual sigue disponible, igual que sin el módulo.
- **Merma desde cocina y barra.** `MermaRapida` (en `components/inventario/`) enseña «Registrar merma» junto a la estación y abre el mismo `MermaDialog` del inventario. No pinta nada sin `inventario.mermar` o sin el módulo `inventory`, y no escucha los ingredientes hasta que se abre. No enseña costes: el diálogo y la respuesta de `registrarMerma` solo llevan cantidades.
- **Prueba de punta a punta.** `scripts/fase4-navegador.ts` recorre todo en un navegador real contra los emuladores con las funciones de verdad (sin ellas no saltan los disparadores de consumo). Las operaciones de sala hechas desde la pantalla (`enviarPedido`, `marcharPase`, `cambiarEstadoLineas`) viajan por la cola local de la fase 6 (`sincronizarComando`). Los procesos programados (`revisarFichajesAbiertos`, `reconciliarConsumos`) no se ejecutan en el emulador sin Pub/Sub: el fichaje olvidado lo deja marcado el seed.

### Decisiones y dudas para el propietario

| Decisión o duda | Recomendación |
|---|---|
| Fichar en una tableta del local | sesión de un encargado más PIN individual de 4 a 6 cifras, además del móvil con sesión propia; activarlo por restaurante |
| Pausas: ¿cuentan como trabajadas? | descontarlas por defecto y dejarlo configurable; confirmar con el convenio |
| Redondeo de horas | sin redondeo por defecto; ofrecer 5, 10 o 15 minutos si el restaurante lo pide |
| Fichar sin conexión | no en esta fase; el encargado crea el fichaje a mano; valorar en la fase 6 |
| Cuándo se descuenta el stock | al marchar la línea; si prefieres al servir o al cobrar, cambia solo `lineConsumptionTarget` |
| Vender sin existencias | permitirlo y dejar el stock en negativo con aviso, en vez de bloquear la venta |
| Raciones del día frente a almacén | que convivan: el contador diario manda para bloquear; el almacén solo informa; no marcar agotados automáticamente |
| Lotes y caducidades | dejarlos fuera de esta fase; controlar caducidad con merma y recuento |
| Quién recibe la mercancía | el encargado; abrir a cocina más adelante si lo piden (permiso nuevo `compras.recibir`) |
| Costes con o sin IVA | siempre sin IVA; precios de proveedor sin IVA |
| Elaboraciones intermedias | fuera de esta fase; ingredientes comprados o descritos en el plato |
| En qué plan van `staff` e `inventory` | solo en el plan completo (Grupo) y encendibles aparte por LogiQD; cuadrar con la decisión 5 del plan antes de vender |
| Propinas por horas | proponer las horas fichadas y que el encargado las apruebe; no automatizar el reparto |
| Conservación de fichajes frente a borrado RGPD | conservar cuatro años a disposición de inspección, a confirmar con asesor laboral, e informarlo en privacidad |
| Aviso al personal al publicar el cuadrante | sin aviso en esta fase; WhatsApp o correo cuando exista la plantilla aprobada |

El reparto exclusivo de implementación está al final de `docs/tareas/fase-4-reparto.md`. Firmas y core se congelan al integrar este contrato; cualquier ampliación pasa por el coordinador.

## Fase 5 · Clientes, marketing y análisis

**Contrato e implementación local.** Core entrega esquemas, callables, cálculos y pruebas en `packages/core/src/fidelizacion/`, `marketing/`, `analisis/`, `api-fidelizacion.ts`, `api-marketing.ts`, `api-analisis.ts` y `api-fase5.ts`. El backend local está implementado en `functions/src/fase5/`, con reglas e índices de fase 5, seed y trabajadores locales. Las pantallas y los enganches comunes están conectados en el cierre local del 2026-11-10. Todo sigue en `demo-llenamos`, con emuladores y sin servicios externos: ni Repite, ni WhatsApp, ni correo, ni Stripe reales. Se conservan `europe-west1`, ms UTC en core y callables, `Timestamp` en Firestore, **dinero en céntimos enteros y puntos enteros**, y los cálculos en el servidor. Core no importa Firebase, no lee el reloj y no añade dependencias. Las métricas **reutilizan** lo que ya guardan las fases 1 a 4 (reservas, mesas, cuentas y pagos de caja, plazas del plano y el coste congelado de `lineCosts`): no recalculan precios, totales ni costes. Se inspira en `docs/tareas/comparativa-restaurantos.md` (filas AN01 a AN09, FI01 a FI04 y las filas «5» del apartado 24) sin copiar código.

### Módulos, planes y permisos

Tres módulos nuevos en `MODULES`, y `repite` (que ya existía) gana contenido:

| Módulo | Qué trae | Depende de |
|---|---|---|
| `loyalty` (Fidelización y promociones) | programa de puntos, premios, canjes y promociones validadas | `pos` para canjear y aplicar promociones en una cuenta; acumular puntos necesita cuentas cobradas |
| `marketing` (Campañas y origen de reservas) | segmentos, campañas por correo y WhatsApp con permiso, informe de origen | `reservations` para el origen; los envíos usan la cola de mensajes de la fase 1 |
| `analytics` (Análisis y previsión) | panel, comparativas, exportación CSV, resumen diario, previsión y automatizaciones | lo que haya: sin `pos` no hay ventas y el panel lo dice; sin `inventory` no hay margen |
| `repite` (Repite) | tarjeta de sellos en el Wallet del servicio Repite: sello al sentar o al cobrar, tarjeta en la ficha, aviso «te echamos de menos» e informe del mes | además, la conexión con Repite (`settings/repite.merchantId`, que fija LogiQD) |

Planes antiguos: no cambian. `completo` es `MODULES` y trae los tres nuevos (como pasó con `staff` e `inventory`); `reservas` y `sala` no traen ninguno. Un restaurante migrado con `entitlementVersion` no los hereda. **`provisionalPlanCatalog` de la fase 6 no se toca.** La propuesta comercial va aparte, en `PHASE5_PLAN_PROPOSAL`, **provisional y pendiente del propietario** (decisiones 5 y 8):

| Plan comercial | Módulos de la fase 5 propuestos |
|---|---|
| Barra | `analytics` |
| Sala | `analytics`, `marketing` |
| Grupo | `analytics`, `marketing`, `loyalty` |
| Aparte | `repite`: **apagado por defecto en todos**, lo enciende LogiQD con `moduleOverrides` y no funciona sin `merchantId` |

Apagar un módulo nunca borra puntos, campañas, orígenes ni recomendaciones; deja de enseñarlos y de procesarlos. Los puntos no caducan por apagar el módulo (la caducidad sigue su fecha).

Nueve permisos nuevos en `roles.ts` (interfaz, funciones y reglas dicen lo mismo):

| Permiso | owner | manager | waiter | kitchen | bar | Módulo |
|---|---|---|---|---|---|---|
| `fidelizacion.ver` (puntos y tarjeta Repite en la ficha del cliente) | ✓ | ✓ | ✓ | | | loyalty o repite |
| `fidelizacion.operar` (dar de alta, canjear, anular un canje de una cuenta abierta, crear tarjeta, sello a mano) | ✓ | ✓ | ✓ | | | loyalty o repite |
| `promociones.aplicar` (ver y aplicar o quitar la promoción de una cuenta) | ✓ | ✓ | ✓ | | | loyalty y pos |
| `fidelizacion.gestionar` (programa, premios, ajustes de puntos, ajustes e informe de Repite, aviso «te echamos de menos») | ✓ | ✓ | | | | loyalty o repite |
| `promociones.gestionar` (crear, pausar y archivar promociones) | ✓ | ✓ | | | | loyalty |
| `campanas.gestionar` (ajustes, segmentos, campañas, simular, cancelar, informes) | ✓ | ✓ | | | | marketing |
| `campanas.lanzar` (programar el envío de una campaña, que cuesta dinero) | ✓ | | | | | marketing |
| `analisis.ver` (panel, comparativas, exportación, previsión, resumen, recomendaciones e informe de origen) | ✓ | ✓ | | | | analytics (origen: marketing) |
| `analisis.configurar` (resumen diario, umbrales y automatizaciones) | ✓ | ✓ | | | | analytics |

Cocina y barra no reciben ninguno. El camarero ve los puntos de un cliente y aplica lo que el servidor valida, pero no ve ventas ni campañas. El margen del panel exige además `costes.ver` y el módulo `inventory` (fase 4). `vincularRepite` exige el claim `logiqd`, que no es un permiso de la matriz. `FASE5_ACCESS` es la fuente de verdad de permiso y módulos de cada callable.

### Datos y autores de las escrituras

Rutas bajo `restaurants/{rid}`; las de local, bajo `restaurants/{rid}/locations/{lid}`. **Ningún documento nuevo admite escritura directa de cliente.** Las callables y procesos toman el autor de Auth (o lo dejan nulo si actúa el sistema), comprueban miembro activo y `locationIds`, y guardan `createdAt`, `updatedAt` y `updatedBy` del servidor. Core lee `Timestamp` y ofrece adaptadores `xxxForWrite` con conversor recibido.

```
restaurants/{rid}
  settings/loyalty               LoyaltySettings (enabled, pointsPerEuro, minSpendCents, expiryDays|null, termsVersion)
  settings/marketing             MarketingSettings (maxPer30Days, minHoursBetween, sendWindow, senderName)
  settings/analytics             AnalyticsSettings (dailySummary, forecast {lowOccupancyBp, highOccupancyBp, daysAhead}, lapsedAfterDays)
  settings/repite                RepiteSettings (merchantId|null ← solo LogiQD, enabled, stampOn seated|paid|both, autoCreateCard)
  loyaltyAccounts/{customerId}   LoyaltyAccount (status, balance, earned, redeemed, expired, termsVersion, enrolledAt, enrolledBy, revision)
  loyaltyMovements/{movementId}  LoyaltyMovement                        ← libro inmutable; ids automáticos deterministas
  loyaltyRewards/{rewardId}      LoyaltyReward
  loyaltyRedemptions/{id}        LoyaltyRedemption (applied → settled o reversed)
  promotions/{promotionId}       Promotion (con status, uses y revision)
    customerUses/{customerId}    uses                                   ← solo servidor, cupo por cliente
  repiteCards/{customerId}       RepiteCardLink (merchantId, cardId, externalRef opaco, status)   ← enlace, no copia de la tarjeta
  repiteOutbox/{operationId}     RepiteOperation                        ← solo servidor; stamp.{visitKey}, card.{customerId}, missyou.{customerId}.{fecha}
  segments/{segmentId}           Segment (name, rule, revision)
  campaigns/{campaignId}         Campaign (status, scheduledAt, launchedBy, stats, cursor, revision)
    recipients/{customerId}      CampaignRecipient (status, excludedReason, messageId)   ← sin contacto
  marketingSendLog/{customerId}  entries [{ at, campaignId }] de los últimos 30 días     ← solo servidor
  unsubscribeTokens/{hash}       UnsubscribeToken (customerId, purpose, messageId, campaignId, usedAt)   ← solo servidor, secreto
  automationRules/{ruleId}       AutomationRule (con revision)
  automationEvents/{eventId}     AutomationEventInstance                ← solo servidor; base de la simulación (92 días)
  recommendations/{firingId}     Recommendation                         ← id {ruleId}.{eventId}
  dailySummaries/{fecha}         texto, totales y a quién se mandó       ← solo servidor
  fase5Requests/{hash}           requestId, actor, huella de la entrada, resultado   ← solo servidor, idempotencia
  locations/{lid}
    reservationOrigins/{reservationId}  ReservationOrigin (canal, utm limpios, campaignId, adId, tipos de clic, dominios, fecha, comensales)
    billPromotions/{billId}             BillPromotion (una por cuenta)
    analyticsDays/{fecha}               totales del día (MetricTotals), horas y platos, computedAt, sourceVersion   ← solo servidor
```

**Ampliaciones aditivas de fases anteriores** (opcionales, sin cambiar lo que ya existe):

- `BillAdjustment.kind` admite `discount`, con `promotionId` o `redemptionId`. Solo lo escribe el servidor al aplicar una promoción o canjear un premio; `ajustarCuenta` sigue admitiendo solo `invitation` y `void`. `netBillLines` y la factura ya lo restan como cualquier ajuste. Ids deterministas `promo.{promotionId}.{lineId}` y `reward.{redemptionId}.{lineId}` (`discountAdjustmentId`).
- `Message` admite `purpose` (`marketing_email`, `marketing_whatsapp`), `customerId` y `campaignId`. Los mensajes de marketing los llevan siempre; los avisos de reserva, nunca. La fase 6 ya cancela por `purpose` al retirar un permiso. Plantillas nuevas `marketing_campaign` (título, texto, enlace y **siempre** la línea de baja) y `daily_summary`, en los tres idiomas.
- `crearReservaPublica` admite `attribution` (`ReservationAttributionInputSchema`) y `marketingOptIn` (`PublicMarketingOptInSchema`). El widget y la web pública los rellenan con `attributionFromUrl`.

Toda mutación lleva `requestId`. Una llamada repetida con el mismo actor, nombre y `requestId` y la misma entrada devuelve el resultado original sin repetir efectos; con otra entrada, `already-exists`. Errores: `permission-denied` (permiso, módulo, local o claim), `failed-precondition` (revisión obsoleta, cuenta cerrada, campaña en estado incompatible, sin consentimiento), `not-found`, `invalid-argument`, `already-exists`, con mensaje en castellano para enseñar.

### Origen de cada reserva

`classifyOrigin` decide el canal **en la propia reserva**, por último toque y sin cookies ni seguimiento entre visitas. Orden: lo que apunta el personal (`phone`, `walk_in`, `import`; `waitlist` si no trae nada) manda; después el enlace de campaña de Llenamos (`llc`); después anuncios (identificadores de clic de Google, Meta o TikTok, o `utm_medium` de pago); después correo, WhatsApp, Instagram, Facebook, TikTok, Google Maps y Google por utm o referente; después la web del restaurante (widget o dominio propio), otra web (`referral`) y por fin `direct`. Canales en `ORIGIN_CHANNELS`. Se guarda solo el **dominio** del referente, los utm limpios y cortos, `adId` (de `utm_id` o `ad_id`) y **de qué tipo** eran los identificadores de clic, nunca su valor ni la URL completa: así `reservationOrigins` no tiene datos personales. La web de Llenamos no cuenta como referente. `campaignLink` construye el enlace de una campaña con los utm estándar y `llc`. El servidor escribe el origen **en la misma transacción** que crea la reserva (pública, del personal, importada o desde la lista de espera); las reservas anteriores a la fase 5 salen como «sin origen» en el informe. `originReport` agrupa por canal, campaña y anuncio: reservas, comensales, presentados, no presentados, canceladas y ventas cobradas de sus mesas.

### Puntos de fidelidad

- **Alta**: con el cliente delante, el personal (`fidelizacion.operar`) confirma que acepta las condiciones (`termsVersion` de los ajustes). No se da de alta a nadie por importar o por reservar. El alta no es un permiso de marketing.
- **Ganar**: al liquidarse una cuenta con `customerId` de un cliente dado de alta y con el programa encendido, `pointsForSpend` da `floor(cobrado × pointsPerEuro / 100)` sobre el total de la cuenta tras invitaciones, descuentos y canjes, **sin propina**, y cero por debajo de `minSpendCents`. **Una sola vez por cuenta**: el movimiento es `earn.{billId}` y se crea con `create` en la transacción, así un disparador repetido no duplica. Cada tanda caduca a los `expiryDays` (365 por defecto; null, nunca).
- **Libro FIFO** (`replayLots`): lo que sale (canje, ajuste en contra, caducidad, devolución) se descuenta de las tandas que caducan antes. **Nunca hay saldo negativo**: `planRedemption` lo impide y `applyLoyaltyMovement` lo vuelve a comprobar. Un punto caducado no se canjea aunque el proceso de caducidad no haya pasado (`availablePoints` mira la fecha).
- **Canjear** (`canjearPuntos`): contra una cuenta **abierta** con su revisión. El servidor lee el libro, el premio y la cuenta en la transacción, escribe `redeem.{redemptionId}`, el canje y los ajustes `discount` de la cuenta (repartidos con `allocateDiscount`, nunca más que el saldo de una línea; un premio de plato descuenta como mucho su precio y `valueCents`). Sin saldo, `insufficient` sin escribir. `anularCanje` mientras la cuenta no esté cobrada: quita los ajustes y devuelve los puntos con `redeem_reversal.{id}` (tanda nueva que caduca a los `expiryDays` desde ese momento). Al liquidarse la cuenta, el canje pasa a `settled`.
- **Devolución de la cuenta**: `planEarnReversal` conserva los puntos en proporción a lo que queda cobrado (hacia abajo), quita la diferencia como mucho hasta el saldo (`earn_reversal.{paymentId}`) y apunta en actividad lo que no se pudo recuperar porque ya se había canjeado. No depende de los ajustes de hoy.
- **Ajuste a mano** (`ajustarPuntos`, `fidelizacion.gestionar`): con motivo, nunca deja saldo negativo, y actividad `loyalty.adjusted`.
- **Caducidad**: el proceso diario escribe `expire.{earnMovementId}` por cada tanda vencida con puntos (`planExpirations`).

### Promociones validadas en el servidor

Una promoción tiene descuento (porcentaje en puntos básicos o importe), ámbito (cuenta, platos o categorías), locales, canales (`dine_in`, `takeaway`, `qr`), fechas, días de la semana y franjas (una franja que cruza la medianoche cuenta para el día en que empieza), gasto mínimo, tope de descuento, cupo total y por cliente, código opcional y compatibilidad. `evaluatePromotion` decide con la cuenta vigente, **el reloj del servidor** y los cupos leídos en la transacción, y da el motivo si no vale (`PROMOTION_REJECTIONS`). Reglas fijas:

- **Una sola promoción por cuenta** (`billPromotions/{billId}`). No se suman promociones. Entre varias válidas, `bestPromotion` elige el mayor descuento, después la mayor prioridad y después el id.
- **Compatibilidad**: `exclusive` no se aplica a una cuenta con un canje de puntos (ni se canjea sobre una cuenta con promoción exclusiva); `with_loyalty` sí.
- **Cupos sin carreras**: `uses` de la promoción y `customerUses/{customerId}` se leen y suben en la misma transacción que escribe los ajustes; quitar la promoción antes de cobrar los devuelve. Un cupo por cliente exige cliente en la cuenta.
- Porcentaje redondeado hacia abajo; el descuento se reparte entre las líneas que entran con `allocateDiscount` (restos mayores, suma exacta).
- La caja nunca manda el importe del descuento: manda la promoción y, si la hay, el código. Si al aplicar ya no vale (otra caja gastó el último cupo, cambió la hora), `rejected` con su motivo.
- Una promoción usada no se borra: se pausa o se archiva. Cambiarla después no toca las cuentas ya cobradas.

### Repite: adaptador, sellos sin duplicar y lo que se espera de su API

Repite (`LogiQD/repite`) es **otro sistema y la única fuente de verdad** de tarjetas y sellos. Hoy guarda sus pilotos en un JSON (`datos/datos.json`) y su única API de máquina a máquina es la de HQ (`/api/hq/…`, alta y edición de negocios con un token); **no existe todavía la API que necesita Llenamos**. Pasar Repite a una base de datos para muchos locales y publicar esa API es trabajo de su repositorio, fuera de esta fase. Lo que Llenamos espera está escrito en `docs/integraciones/repite-api.md`.

- **Adaptador** (`RepiteAdapter` en `fidelizacion/repite.ts`): `createCard`, `addStamp`, `getCard`, `sendWeMissYou`, `monthReport` y `removeCard` (borrado por privacidad). Toda operación que cambia algo lleva `idempotencyKey`. Las respuestas son `{ ok: true, value }` o `{ ok: false, error: { code, message, retryable } }` con `REPITE_ERROR_CODES`. `notConfiguredRepite()` responde siempre `not_configured`; `createLocalRepite()` es el **doble local** en memoria para pruebas y emuladores (idempotencia, una visita un sello, espera mínima entre sellos, aviso semanal, informe mensual y `failNext` para probar reintentos). Fuera del emulador, mientras no exista la API, el backend usa `notConfiguredRepite` y la interfaz dice «Repite no está conectado»; **nunca se enseña un sello como dado si Repite no lo confirmó**.
- **Datos mínimos**: Llenamos manda a Repite un `externalRef` aleatorio opaco (guardado en `repiteCards`) y el nombre de pila; nunca el teléfono, el correo ni el `customerId`.
- **Sello al sentar o al cobrar sin duplicar**: `repiteVisitKey` da la misma clave al sentar y al cobrar la misma visita (con reserva, la reserva; sin ella, la mesa; para llevar, el pedido). `stampOn` elige `seated`, `paid` o `both`; con `both` el segundo es duplicado. El disparador crea `repiteOutbox/stamp.{visitKey}` con `create` (si ya existe, nada), y el trabajador llama a `addStamp` con esa misma clave de idempotencia. Sin tarjeta: si `autoCreateCard`, primero `card.{customerId}`; si no, la operación queda `skipped`.
- **Cola** (`RepiteOperation`): `queued → leased → done | duplicate | failed | not_configured | skipped`. `settleRepiteOperation` decide; reintentos a los 30 s doblando hasta 6 h y como mucho 12 (`nextRepiteAttempt`). Un error no reintentable o agotado queda `failed` visible en la ficha y en el panel, con `darSelloRepite` para reintentar a mano con la misma clave.
- **Ficha del cliente**: `verTarjetaRepite` pregunta a Repite al momento y devuelve el estado con `fetchedAt`, o por qué no está. No se guarda una copia de la tarjeta.
- **«Te echamos de menos»**: `avisarTeEchamosDeMenos` encola `missyou.{customerId}.{fecha}` para clientes con tarjeta, como mucho uno por cliente y día en Llenamos y con los límites del propio Repite (uno por semana). No se manda a quien retiró su permiso de marketing en algún canal. Un segmento de clientes que no vienen (`lastVisitAtLeastDaysAgo`) sirve para elegirlos.
- **Informe del mes**: `informeRepite` lo pide a Repite (`monthReport`) y lo enseña tal cual, con el mes anterior si Repite lo da.
- **Credenciales**: URL y token de servicio de Repite son variables del servidor (`REPITE_API_URL`, `REPITE_API_TOKEN`), nunca del navegador ni del repositorio. El `merchantId` de cada restaurante lo fija LogiQD con `vincularRepite` (claim, motivo y actividad): un restaurante no puede apuntar a las tarjetas de otro negocio.

### Segmentos y campañas con permiso

- **Permiso**: se usan los consentimientos de la fase 6 (`consents`, `hasCurrentConsent`, propósitos `marketing_email` y `marketing_whatsapp`). Se consiguen en la web pública (casillas **desmarcadas por defecto** de `marketingOptIn`: cada casilla marcada crea un `Consent` `granted` con `source: "public"`, la versión de la política y la reserva como evidencia, en la misma transacción que la reserva) o con `registrarConsentimiento` de la fase 6. Importar contactos no da permiso. Los mensajes de reserva no dan permiso.
- **Segmento** (`SegmentRule`): visitas, días desde la última visita (incluidos o no los que nunca vinieron), no presentados, gasto, etiquetas, idioma y puntos. `matchesSegment` es puro.
- **Audiencia** (`planCampaignAudience`): clientes del segmento **con contacto del canal y consentimiento vigente de ese canal**, sin baja, sin suprimidos por privacidad (tombstones de la fase 6), sin contactos repetidos y dentro del **límite de frecuencia** (`frequencyAllows`: `maxPer30Days` mensajes de marketing por cliente en 30 días sumando canales, 2 por defecto, y `minHoursBetween` horas entre dos, 72 por defecto). Lo que no entra se cuenta por motivo (`CAMPAIGN_EXCLUSIONS`) y se enseña; nunca se manda a quien no consintió o se dio de baja.
- **Envío**: `lanzarCampana` (solo owner) programa. El proceso prepara los mensajes por páginas de 200 y, **en cada transacción**, vuelve a llamar a `assertMarketingConsent` (fase 6), comprueba la frecuencia en `marketingSendLog`, crea el mensaje `campaign.{campaignId}.{customerId}` con `purpose`, `customerId` y `campaignId`, el token de baja y el destinatario. `sendAt` cae dentro de la ventana local (`nextSendTime`, de 10:00 a 21:00 por defecto). El procesador de mensajes de la fase 1 **vuelve a comprobar el consentimiento antes de enviar** cualquier mensaje con `purpose` y lo cancela si ya no vale. Sin claves del proveedor, `captured` en el emulador y `not_configured` fuera: no se envía nada.
- **WhatsApp**: un mensaje de marketing fuera de la ventana de atención necesita una plantilla aprobada por Meta y la cuenta de WhatsApp Business verificada (decisión 4 del plan). Hasta entonces, las campañas por WhatsApp se pueden preparar y simular, pero el proveedor las deja `not_configured` y la interfaz lo dice.
- **Baja**: cada mensaje lleva su enlace `/baja/{slug}?t=…`. `darseDeBaja` es pública, **funciona siempre (también con el módulo apagado)**, responde igual exista o no el token, y escribe un `Consent` `withdrawn` con `source: "public"` y el mensaje como evidencia; la fase 6 cancela lo que siga en cola de ese propósito. Responder por WhatsApp una palabra de `UNSUBSCRIBE_WORDS` («baja», «stop»…) a un mensaje de marketing hace lo mismo (lo recoge el webhook de WhatsApp de la fase 1).
- **Medida**: el enlace de reservas del mensaje lleva `llc`, así `informeCampana` cuenta mensajes por estado, bajas y reservas, comensales, presentados y ventas que trajo.

### Métricas del panel

Definiciones en `analisis/metricas.ts` (todas en céntimos enteros; los cocientes, redondeados a la mitad hacia arriba; un cociente sin base es `null`, nunca un cero inventado):

| Métrica | Definición |
|---|---|
| Pedido | líneas de las cuentas cobradas antes de invitaciones, anulaciones y descuentos, IVA incluido |
| Ventas brutas | total de las cuentas **liquidadas** en el periodo, tras invitaciones, anulaciones y descuentos, IVA incluido y **sin propinas**, en el día local en que se liquidan. Una cuenta abierta no es venta |
| Devoluciones | devoluciones confirmadas, en el día en que se hacen |
| Ventas netas | ventas brutas sin IVA menos devoluciones sin IVA |
| Descuentos | invitaciones más descuentos de promociones y canjes |
| Comensales | los de las mesas cobradas; los pedidos para llevar no cuentan |
| Ticket medio y gasto por comensal | ventas brutas / cuentas; ventas brutas de mesas / comensales |
| Rotación | comensales / (plazas × días abiertos), en puntos básicos |
| Ingreso por plaza y hora | ventas brutas de mesas / (plazas × horas abiertas) |
| Ocupación | minutos de comensal sentado / (plazas × minutos abiertos), como mucho 10 000 |
| No presentados | `no_show` / reservas que debían llegar (confirmadas, sentadas, terminadas o no presentadas), y comensales perdidos |
| Horas punta | comensales, cuentas y ventas por tramo (15, 30 o 60 minutos) de la hora en que se abrió la mesa, y reservas por hora de llegada (`peakSlots`) |
| Platos | unidades sueltas y dentro de menú y ventas por plato, más vendidos, menos vendidos y **los de cero ventas** de la carta activa (`dishSales`) |
| Margen | el de la fase 4 (`summarizeDishMargins`) con el coste congelado de cada línea, sin los platos de menú, con la cobertura (parte de unidades con coste) y la merma (`marginTotals`) |

Las plazas son las de las mesas habilitadas del local y los minutos abiertos salen de los horarios de la fase 1 (excepciones y cierres incluidos). `comparePeriods` compara con el periodo anterior de la misma longitud (`previousRange`) y devuelve **todo vacío** si no hay base (`hasBase`). `compareLocations` da las métricas de cada local y su parte de las ventas; quien tiene `locationIds` solo compara los suyos. `computeTotals` rechaza una cuenta que no cuadra (pedido menos ajustes distinto del total) en vez de dar una cifra.

El proceso nocturno guarda `analyticsDays/{fecha}` por local con los totales del día (`MetricTotals`), horas y platos; el panel suma esos días con `addTotals` y deriva los cocientes de las sumas (nunca promedia porcentajes), y calcula hoy al momento. Una devolución tardía recalcula los últimos días. `exportarAnalisis` da CSV para Excel (`toCsv`: punto y coma, coma decimal, BOM, sin fórmulas) de ventas por día, platos, horas, locales y origen (este, con el módulo `marketing`), hasta 92 días. No es una copia ni la exportación personal de la fase 6: no lleva contactos.

### Resumen diario

`settings/analytics.dailySummary` (apagado por defecto): hora, canales, personas que lo reciben (owner o manager activos) y si resume el día anterior o el mismo día. El proceso, cada 15 minutos, mira `dailySummaryDate` y, si toca, calcula los totales del día y los del mismo día de la semana anterior, las reservas de hoy y los avisos abiertos (stock bajo, fichajes olvidados, recomendaciones), guarda `dailySummaries/{fecha}` y encola `daily-summary.{fecha}.{uid}.{canal}` con la plantilla `daily_summary` y el texto de `renderDailySummary`. Un resumen por día, persona y canal aunque el proceso pase varias veces. No es marketing: no lleva `purpose`. Sin claves del proveedor, nada sale (`captured` o `not_configured`).

### Previsión de ocupación

`forecastDay` estima los comensales sentados en cada tramo de 15 minutos de un día con los mismos días de la semana de hasta **12 semanas** atrás, con peso `13 − k` para la semana `k` (más a lo reciente), **sin contar los días cerrados** como cero, y toma como mínimo lo ya reservado (`projected`). Confianza por muestras: menos de 3, baja; de 3 a 7, media; 8 o más, alta; y baja un nivel si los totales del día varían más de un 25 % (`volatile`). `presenceBySlot` saca la presencia de un día de las mesas abiertas (las que cruzan la medianoche cuentan en su día; las horas que no existen en el adelanto de marzo se saltan). `previsionOcupacion` da hasta 14 días; la pantalla enseña siempre cuántas semanas la respaldan. No hay previsión de demanda por plato ni carga por estación en esta fase.

### Automatizaciones que solo recomiendan

Una regla tiene evento (`AUTOMATION_EVENTS`: no presentado, cancelación, previsión baja o alta, stock bajo, cliente que no viene, día cerrado), condiciones (todas o alguna, como mucho dos niveles, solo con los campos que da ese evento), recomendación (`RECOMMENDATIONS`), enfriamiento por asunto (cliente, día o ingrediente) y locales. Los productores (disparadores de reservas y stock, el proceso diario de previsión y de clientes que no vienen, el cierre del día) escriben `automationEvents/{id}` sin datos personales; el evaluador aplica `evaluateRule` y crea `recommendations/{ruleId}.{eventId}` (un evento nunca recomienda dos veces). **Aceptar o descartar no ejecuta nada**: queda quién y cuándo, y la pantalla enlaza con donde se hace a mano (pedir señal, preparar una campaña, revisar el cuadrante…). Una recomendación sin decidir caduca (`expired`). `simularAutomatizacion` prueba una regla contra los eventos guardados de hasta 92 días con `simulateRule`, sin escribir nada.

### Callables (contrato para el backend)

39 nombres, región `europe-west1`, integrados en `CALLABLES`, `CALLABLE_SCHEMAS` y `CallableInput/ParsedInput/Output` desde `api-fase5.ts`. **R** = `{ restaurantId }`; **RM** = R más `requestId`; **S** = R más `locationId`; **M** = S más `requestId`. Todos exigen sesión de Auth y miembro activo (salvo `darseDeBaja`, pública, y `vincularRepite`, claim `logiqd`); los de local exigen acceso a ese local. Ninguna entrada trae importes de descuento, saldos, usos, autor ni estados.

| Callable | Entrada adicional | Salida | Permiso y módulo |
|---|---|---|---|
| guardarConfiguracionFidelizacion | RM, settings | ok | fidelizacion.gestionar, loyalty |
| guardarPremio | RM, rewardId\|null, expectedRevision\|null, reward | rewardId, revision | fidelizacion.gestionar, loyalty |
| altaFidelizacion | RM, customerId, acceptedTermsVersion | balance, enrolledAt, alreadyEnrolled | fidelizacion.operar, loyalty |
| verCuentaFidelizacion | R, customerId | enrolled, available, expiringIn30Days, earned, redeemed, expired, movements[≤50], rewards[] | fidelizacion.ver, loyalty |
| canjearPuntos | M, customerId, rewardId, billId, expectedBillRevision | applied (redemptionId, points, discountCents, available, billRevision) o insufficient | fidelizacion.operar, loyalty y pos |
| anularCanje | M, redemptionId, expectedBillRevision, reason | available, billRevision | fidelizacion.operar, loyalty y pos |
| ajustarPuntos | RM, customerId, points (con signo, no cero), reason | movementId, available | fidelizacion.gestionar, loyalty |
| guardarPromocion | RM, promotionId\|null, expectedRevision\|null, promotion | promotionId, revision, status | promociones.gestionar, loyalty |
| cambiarEstadoPromocion | RM, promotionId, expectedRevision, to active/paused/archived | revision, status | promociones.gestionar, loyalty |
| promocionesAplicables | S, billId, code\|null | channel, best\|null, evaluations[] | promociones.aplicar, loyalty y pos |
| aplicarPromocion | M, billId, expectedBillRevision, promotionId, code\|null | applied (discountCents, billRevision, totalCents) o rejected (reason, message) | promociones.aplicar, loyalty y pos |
| quitarPromocion | M, billId, expectedBillRevision, reason | billRevision, totalCents | promociones.aplicar, loyalty y pos |
| vincularRepite | RM, merchantId\|null, reason | ok | claim logiqd |
| guardarAjustesRepite | RM, settings (sin merchantId) | ok, connected | fidelizacion.gestionar, repite |
| crearTarjetaRepite | RM, customerId | ready (cardId, saveUrl), queued o no disponible | fidelizacion.operar, repite |
| verTarjetaRepite | R, customerId | ready (card, fetchedAt), no_card o no disponible | fidelizacion.ver, repite |
| darSelloRepite | M, customerId, reservationId\|null, sessionId\|null | operationId, status | fidelizacion.operar, repite |
| avisarTeEchamosDeMenos | RM, customerIds[1…100] | queued, skipped[] | fidelizacion.gestionar, repite |
| informeRepite | R, month AAAA-MM | ready (cifras y mes anterior) o no disponible | fidelizacion.gestionar, repite |
| guardarConfiguracionMarketing | RM, settings | ok | campanas.gestionar, marketing |
| guardarSegmento | RM, segmentId\|null, expectedRevision\|null, segment | segmentId, revision | campanas.gestionar, marketing |
| borrarSegmento | RM, segmentId, expectedRevision | ok (no si lo usa una campaña viva) | campanas.gestionar, marketing |
| previsualizarSegmento | R, rule, channel | audience, recipients, excluded{}, sample[≤20 sin contacto] | campanas.gestionar, marketing |
| guardarCampana | RM, campaignId\|null, expectedRevision\|null, campaign | campaignId, revision (solo borradores) | campanas.gestionar, marketing |
| simularCampana | R, campaignId | audience, recipients, excluded{}, preview, firstSendAt | campanas.gestionar, marketing |
| lanzarCampana | RM, campaignId, expectedRevision, at\|null | revision, status, scheduledAt | **campanas.lanzar** (owner), marketing |
| cancelarCampana | RM, campaignId, expectedRevision, reason | revision, cancelledMessages | campanas.gestionar, marketing |
| informeCampana | R, campaignId | estados de los mensajes, exclusiones, bajas, reservas, comensales, presentados y ventas | campanas.gestionar, marketing |
| darseDeBaja | slug, token, website (trampa) | ok, siempre | pública, sin módulo |
| informeOrigen | R, from, to, locationIds\|null | rows[], withoutOrigin | analisis.ver, marketing |
| panelAnalisis | R, from, to (≤366 días), locationIds\|null, compare, slotMinutes | total, comparison\|null, byLocation[], byDay[], hours, dishes, margin\|null, computedAt | analisis.ver, analytics (margen: costes.ver e inventory) |
| exportarAnalisis | R, from, to (≤92 días), locationIds\|null, kind | filename, csv, rows | analisis.ver, analytics |
| guardarConfiguracionAnalisis | RM, settings | ok | analisis.configurar, analytics |
| previsionOcupacion | S, from, days 1…14 | seats, days[] con tramos, confianza y pico | analisis.ver, analytics y reservations |
| verResumenDiario | R, date | date, text, sentTo[] | analisis.ver, analytics |
| guardarAutomatizacion | RM, ruleId\|null, expectedRevision\|null, rule | ruleId, revision | analisis.configurar, analytics |
| borrarAutomatizacion | RM, ruleId, expectedRevision | ok (las recomendaciones quedan) | analisis.configurar, analytics |
| simularAutomatizacion | R, rule, from, to (≤92 días) | events, fired[], skipped{}, sample[] | analisis.configurar, analytics |
| resolverRecomendacion | RM, recommendationId, decision accepted/dismissed, note\|null | status, kind | analisis.ver, analytics |

Las lecturas de listas (premios, promociones activas, segmentos, campañas, recomendaciones, días calculados) las hace el SDK de cliente con las reglas de abajo; las callables son para escribir y para los cálculos que deben ser del servidor. Los permisos y módulos de cada fila están en `FASE5_ACCESS`.

### Estados y transiciones

| Entidad | Transiciones |
|---|---|
| LoyaltyAccount | active → closed (por borrado de privacidad o petición del cliente; el libro se conserva anonimizado) |
| LoyaltyRedemption | applied → settled (cuenta cobrada) o reversed (anulado antes de cobrar); finales |
| Promotion | draft → active; active ↔ paused; draft, active o paused → archived (final); con usos no se borra |
| BillPromotion | applied → removed (antes de cobrar); una por cuenta |
| RepiteOperation | queued → leased → done, duplicate, skipped, not_configured o failed; queued de nuevo al reintentar; failed se reintenta a mano con la misma clave |
| Campaign | draft → scheduled o cancelled; scheduled → draft, sending o cancelled; sending → sent o cancelled (cancela lo que siga en cola); sent y cancelled finales |
| CampaignRecipient | queued → sent, failed o cancelled; excluded final |
| Recommendation | open → accepted, dismissed o expired; finales |
| LoyaltyMovement, ReservationOrigin, AutomationEvent, Consent | solo creación |

### Reglas de Firestore y consultas

Todas exigen miembro activo, acceso al local (en las de local) y módulo, y rechazan escrituras de cliente. Firestore no filtra: las consultas piden siempre los filtros de la regla.

| Ruta | Lectura desde el SDK cliente |
|---|---|
| settings/loyalty, loyaltyRewards, loyaltyAccounts, loyaltyMovements, loyaltyRedemptions | fidelizacion.ver, loyalty |
| promotions (solo `status == "active"`) | promociones.aplicar, loyalty |
| promotions (todas) | promociones.gestionar, loyalty |
| billPromotions | caja.ver, pos y loyalty |
| repiteCards | fidelizacion.ver, repite |
| settings/repite | fidelizacion.gestionar, repite |
| settings/marketing, segments, campaigns y recipients | campanas.gestionar, marketing |
| reservationOrigins | reservas.ver, reservations (el detalle de la reserva enseña su canal) |
| settings/analytics, automationRules, recommendations, analyticsDays | analisis.ver, analytics |
| promotions/customerUses, repiteOutbox, marketingSendLog, unsubscribeTokens, automationEvents, dailySummaries, fase5Requests | nadie desde el SDK cliente |

Índices que habrá que añadir: movimientos de puntos por cliente y fecha; canjes por cuenta y estado; promociones por estado; operaciones de Repite por estado y `nextAttemptAt`; campañas por estado y `scheduledAt`; destinatarios por estado; mensajes por `campaignId` y estado; orígenes por fecha y canal; eventos de automatización por tipo y fecha; recomendaciones por estado y fecha. Pruebas de reglas positivas y negativas por rol, módulo y local: cocina y barra no leen puntos ni promociones; el camarero no lee campañas ni `analyticsDays`; nadie lee `unsubscribeTokens` ni `marketingSendLog`.

### Procesos

| Proceso | Cuándo y garantía |
|---|---|
| `registrarOrigenReserva` | **no es un proceso**: lo escribe en su transacción cada creador de reservas (pública, personal, importación, lista de espera) con `classifyOrigin` |
| `registrarPermisoReserva` | igual, en la transacción de `crearReservaPublica`, con las casillas marcadas de `marketingOptIn` |
| `acumularPuntos` | disparador sobre `bills/{billId}` al pasar a `settled` con cliente dado de alta: `earn.{billId}` con `create`, saldo y actividad en una transacción; marca los canjes de esa cuenta como `settled`. Sobre `payments` de devolución: `earn_reversal.{paymentId}` |
| `caducarPuntos` | diario; `planExpirations` por cuenta con tandas vencidas; ids deterministas |
| `selloRepitePorReserva`, `selloRepitePorCobro` | disparadores al sentar una reserva (o abrir mesa con ella) y al liquidar una cuenta: crean `stamp.{visitKey}` si aplica (`repiteStampApplies`) y no existe |
| `procesarRepite` | al crear una operación y cada minuto para los reintentos; reclama con lease, llama al adaptador con el id como clave y guarda `settleRepiteOperation`. Fuera de la transacción a propósito: un fallo de Repite nunca bloquea sentar ni cobrar |
| `procesarCampanas` | cada 5 minutos: campañas `scheduled` cuya hora llegó pasan a `sending` y se preparan por páginas con cursor; consentimiento y frecuencia en cada transacción; `sent` al terminar la última página |
| `procesarMensajesPendientes` (fase 1) | **integración**: antes de enviar un mensaje con `purpose`, `assertMarketingConsent`; si ya no vale, `cancelled` con motivo |
| `agregarDiaAnalisis` | cada noche por local: `analyticsDays` de ayer y recálculo de los tres días anteriores por devoluciones tardías |
| `enviarResumenDiario` | cada 15 minutos, con `dailySummaryDate` e ids deterministas |
| `evaluarAutomatizaciones` | al crear un `automationEvent`; los productores diarios de previsión y de clientes que no vienen escriben sus eventos una vez al día con id `{tipo}.{asunto}.{fecha}` |
| `caducarRecomendaciones` | diario: `open` pasadas de `expiresAt` → `expired` |

Los programados no corren solos en el emulador: cada uno tiene un script local que llama al mismo trabajador, restringido a demo y a su fila de puertos. El estado de salud distingue nunca ejecutado, última ejecución y fallo.

### Implementación local del backend de la fase 5

Las 39 callables viven en `functions/src/fase5/index.ts` y están exportadas desde la entrada común `functions/src/index.ts`. El inventario de exportaciones está en `functions/src/fase5/reglas.md`. No se ha cambiado ningún esquema, permiso ni firma de core, ni los escritores de las fases 1 a 3. Cada mutación comparte transacción con `fase5Requests`, las escrituras y la actividad con autor; el libro de puntos ordena sus movimientos con un instante creciente por cliente para resolver operaciones en el mismo milisegundo. Canjes y promociones comprueban revisión, consumo vigente, facturas, partes y pagos pendientes y regeneran la parte de la cuenta sin cobros.

Los disparadores de cuentas, devoluciones y reservas acumulan puntos, revierten devoluciones, liquidan canjes y encolan un solo sello por visita. Los productores de reservas y stock y el trabajador diario generan eventos; las recomendaciones solo registran decisiones. Los trabajadores comparten su implementación con `scripts/fase5-trabajadores.ts` y guardan salud privada en `fase5Health/{trabajador}`: ausencia significa nunca ejecutado, `lastRunAt` la última ejecución y `status: failed` un fallo. La previsión exige días con datos de sesiones o agregados; guardar un horario no inventa doce semanas de observaciones.

El adaptador HTTP de Repite solo admite el doble de loopback de `demo-llenamos` (5013 en el cierre de la fila 2), con timeout, validación de respuestas, idempotencia y reintentos que respetan `Retry-After`. Sin `REPITE_API_URL`, o con una URL remota, devuelve `not_configured`; no existe una vía habilitada a Repite real. `repiteLocal` sirve el doble HTTP en Functions; su memoria se reinicia al parar ese proceso. Las referencias opacas se fijan transaccionalmente antes de salir al proveedor. `scripts/seed-fase5.ts` no reinicia saldos ni cupos y añade doce semanas inventadas de servicio. Comandos, pruebas y capturas de diagnóstico a 2x en `functions/src/fase5/README.md` y `docs/diseno/capturas/fase5-backend/README.md`.

El cierre integra origen y consentimiento en las reservas, guardia de permiso en el procesador común, palabras de baja de WhatsApp y borrado de privacidad de fase 6. Fase 5 incluye `cancelarMarketingSinPermiso` para cancelar mensajes en cola cuando se registra una baja, además de la cancelación transaccional de `darseDeBaja` y un capturador exclusivamente local. La guardia del procesador común cancela el mensaje cuando falta consentimiento.

### Integraciones con otras fases (integradas en el cierre)

- Escritores de reservas de la fase 1 (`crearReservaPublica`, `crearReserva`, `importarReservas`, `aceptarOfertaListaEspera`): escribir `reservationOrigins` y, en la pública, los `Consent` de `marketingOptIn`, **en su transacción**. El widget y `/r/[slug]` mandan `attribution` con `attributionFromUrl` (el widget pasa el dominio de la página que lo contiene).
- Procesador de mensajes de la fase 1: comprobación de consentimiento antes de enviar los mensajes con `purpose`; el webhook de WhatsApp reconoce `UNSUBSCRIBE_WORDS` en respuestas a un mensaje de marketing.
- Caja de la fase 3: la pantalla de cuenta enseña los ajustes `discount` como «Descuento» (integrado con la etiqueta «Descuento»), ofrece promociones (`promocionesAplicables`) y canje de puntos; las facturas ya restan el ajuste.
- Ficha de cliente: puntos (`verCuentaFidelizacion`), tarjeta Repite (`verTarjetaRepite`) y origen de sus reservas.
- Fase 6: el inventario de datos personales ya prevé `loyalty`; el borrado cierra la cuenta de puntos, anonimiza el libro, borra `repiteCards` y pide la retirada a Repite (operación de la cola), y los `campaigns/*/recipients` y `marketingSendLog` del cliente. `assertMarketingConsent` se reutiliza tal cual.
- Navegación: entradas `Análisis` (`/panel/analisis`, `analisis.ver`, `analytics`), `Campañas` (`/panel/campanas`, `campanas.gestionar`, `marketing`) y `Fidelización` (`/panel/fidelizacion`, `fidelizacion.gestionar` o `promociones.gestionar`, `loyalty` o `repite`).

### Integración de la fase 5

Cierre local en `fase5/cierre`, 2026-11-10, fila 2. Origen por último toque y permisos opcionales se escriben con la reserva, también cuando llega del widget. Personal, importaciones y ofertas aceptadas escriben su origen sin atribuir consentimiento. Las casillas empiezan vacías; en emuladores usan la política explícita `demo-2026.1`. Fuera de ellos solo se muestran al configurar `NEXT_PUBLIC_MARKETING_POLICY_VERSION` y `NEXT_PUBLIC_MARKETING_POLICY_URL` con la política aprobada del restaurante. No se cambia ninguna firma de core ni el catálogo comercial.

El menú aplica permiso y módulo: configuración de fidelización para owner y manager con loyalty o repite (enlace directo a Repite si solo está ese módulo), campañas con marketing y análisis con analytics. El camarero opera desde cliente y caja. Cocina, barra y el plan sala no reciben entradas de fase 5. La ficha monta `FichaFidelizacion`; la cuenta monta `DescuentosCuenta` y mantiene su suscripción y revisión reales. Los formularios de preferencias y de puntos son independientes. Las comparativas sin denominador conservan «Sin base», nunca se sustituyen por cero.

La cola común comprueba consentimiento antes del envío de marketing. La baja por palabras de WhatsApp retira solo ese canal de forma idempotente. Privacidad cierra la cuenta de puntos, conserva los importes del libro anonimizado y elimina destinatarios, logs, tokens y enlace Repite. Antes del borrado crea una operación determinista de retirada con los identificadores remotos en `result`; los conserva si Repite falla, aunque ya no exista la ficha. También se anonimizan las respuestas idempotentes de fase 5, que rechazan su recuperación posterior. Los costes y movimientos de almacén enlazados, los enlaces de sesión y las revisiones de devolución se incluyen sin alterar sus cantidades. La anonimización conserva los nombres de platos multilingües y motivos técnicos válidos, para que sala, caja y análisis sigan leyendo el histórico. Consentimientos y recomendaciones quedan saneados y válidos; los eventos suprimidos no producen nuevas recomendaciones. El inventario se lee por grupos acotados en el mismo snapshot para no serializar miles de hojas. El cursor sigue el orden del plan completo, también con ids que mezclan mayúsculas y minúsculas. La lectura de los ajustes de marketing separa los metadatos del servidor de los campos estrictos de configuración. No se añaden disparadores de puntos, devolución o sellos a los escritores comunes: se usan los ya exportados una sola vez.

Recorrido, script y resultados verificables en `docs/diseno/capturas/fase5/README.md` y `scripts/fase5-navegador-integracion.ts`; diagnóstico original trasladado a `docs/diseno/capturas/fase5-backend/`. Las decisiones del propietario siguen en la tabla de esta fase: planes y precio de Repite, política y condiciones de puntos, compatibilidad de promociones, permisos y frecuencia de campañas, política de privacidad, plantillas y verificación de WhatsApp, hora del resumen y eventual ejecución de automatizaciones. Hasta resolverlas se conservan las propuestas provisionales y los proveedores locales.

### Core entregado y límites de la fase

`fidelizacion/`: ajustes, cuentas, libro, premios, canjes y promociones (`modelo.ts`); puntos con FIFO, caducidad, canje sin saldo negativo y devolución proporcional (`puntos.ts`); evaluación, mejor promoción, franjas con medianoche y reparto exacto (`promociones.ts`); adaptador, clave de visita, cola con reintentos y doble local de Repite (`repite.ts`). `marketing/`: origen de la reserva y enlaces de campaña (`origen.ts`); segmentos, audiencia con consentimiento, frecuencia, ventana de envío, estados, baja y permiso al reservar (`campanas.ts`). `analisis/`: métricas, comparativas, horas punta, platos y margen (`metricas.ts`); previsión (`prevision.ts`); resumen diario (`resumen.ts`); automatizaciones (`automatizaciones.ts`); CSV (`exportar.ts`). Todo exportado desde `@llenamos/core` con sus pruebas.

No se hace en la fase 5: la API de Repite ni su paso a base de datos (repositorio `LogiQD/repite`); envíos reales por WhatsApp o correo; anuncios ni conexión con Google Ads, Meta o TikTok (solo se leen sus parámetros); seguimiento entre visitas o cookies de terceros; cuenta del comensal o puntos consultables por el cliente desde la web; recomendación de platos en el carrito; automatizaciones que ejecutan; copiloto conversacional y simuladores de precio (AN07, AN08); reconstrucción del servicio (AN05); tiempos de espera, preparación y recogida separados en el panel; previsión de demanda por plato o carga por estación; margen de los menús del día; prorrateo de descuentos en el margen por plato; ni exportación a CSV de pedidos y cobros línea a línea.

### Decisiones y dudas para el propietario

| Decisión o duda | Recomendación |
|---|---|
| En qué plan van `analytics`, `marketing` y `loyalty` (decisión 5) | la propuesta provisional: análisis en todos, campañas desde Sala, fidelización en Grupo; validar antes de vender |
| Qué plan incluye Repite y su precio (decisión 8) | aparte de los tres planes, apagado por defecto y encendido por LogiQD; decidir precio cuando Repite tenga su API y base de datos |
| Cuándo se da el sello de Repite | al sentar (`seated`), que es cuando el cliente está delante; `both` si hay mucho para llevar |
| Puntos: cuántos por euro y cuándo caducan | 1 punto por euro sin propina, caducidad a los 12 meses de ganarlos |
| ¿Puntos y Repite a la vez? | se pueden tener los dos; recomendable elegir uno por restaurante para no confundir al cliente |
| Promociones: automáticas, con código o ambas | ambas; una sola por cuenta, la mejor para el cliente |
| ¿Se suman promoción y canje de puntos? | por defecto no (`exclusive`); el encargado puede permitirlo en cada promoción |
| Quién lanza campañas | solo el propietario, porque cuestan dinero; abrir al encargado si lo pide |
| Límite de frecuencia y horas de envío | 2 por cliente cada 30 días, 72 horas entre dos, de 10:00 a 21:00 |
| ¿El aviso «te echamos de menos» del Wallet necesita permiso de marketing? | tratarlo como parte del programa al que se apuntó, pero no mandarlo a quien retiró su permiso; confirmar con el asesor |
| Texto de las casillas de permiso y versión de la política | redactarlo con el asesor antes de publicar la web con casillas |
| Plantillas de WhatsApp de marketing | hacen falta la cuenta verificada (decisión 4) y plantillas aprobadas por Meta; hasta entonces, campañas por correo |
| Resumen diario: hora y qué día resume | por la mañana (09:00) con el día anterior, por correo |
| Automatizaciones que ejecutan | no en esta fase; decidir qué acciones y con qué aprobación cuando haya ejecutores idempotentes y reversibles |
| Exportación de pedidos y cobros línea a línea (AN03) | no en esta fase; las cinco exportaciones agregadas cubren el uso habitual |

El reparto exclusivo de implementación está al final de `docs/tareas/fase-5-reparto.md`. Firmas y core se congelan al integrar este contrato; cualquier ampliación pasa por el coordinador.

## Fase 6 · Plataforma

**Contrato previo a implementación.** Esta entrega añade modelos, firmas, lógica pura y pruebas en `packages/core/src/plataforma/` y `api-plataforma.ts`. No implementa aún IndexedDB, PWA, Billing, panel, API HTTP, trabajadores, reglas, copias ni borrado real. Se inspira en los apartados 16, 18, 19 y 24 de `docs/tareas/comparativa-restaurantos.md`, sin copiar código. Conserva `europe-west1`, `demo-llenamos`, ms UTC en core y callables, Timestamp en Firestore y dinero en céntimos enteros seguros. Ninguna función pura lee el reloj, genera secretos ni hace red. Sin dependencias nuevas.

### Planes, módulos, alta y acceso

Se conservan `MODULES`, `PLANS`, los permisos existentes y `cambiarPlan` de fase 1. No se añade un rol de restaurante llamado LogiQD: el equipo interno se identifica por **claim `logiqd: true`**, comprobado en servidor. Ser owner no concede ese claim, y tenerlo no concede acceso indiscriminado a datos personales de un restaurante. `scripts/logiqd-equipo.ts` sigue siendo el procedimiento local existente; esta fase no crea cuentas reales ni claims desde el navegador.

Los planes comerciales son **datos versionados**, `PlanDefinition`, independientes del enum de compatibilidad `reservas|sala|completo`. El catálogo de servidor relaciona `id`, `version`, `name`, `legacyPlan`, `provisional`, `enabled`, `modules[]`, `limits {locations,members,apiKeys,webhooks}`, `trialDays`, `currency: EUR`, `monthlyCents`, `annualCents`, `stripeMonthlyPriceId|null`, `stripeAnnualPriceId|null`. Solo LogiQD publica versiones; una versión usada es inmutable y deshabilitar su selección no cambia contratos existentes. Límites `null` significan sin tope, cero prohíbe nuevas altas. Los ids Price de Stripe nunca llegan de la petición del cliente. El precio anual es el **total anual**, no la mensualidad equivalente. Los importes son sin IVA y no incluyen Meta ni comisiones de Stripe.

`provisionalPlanCatalog()` es una **propuesta provisional pendiente de las decisiones 5 y 8 de PLAN.md**, no una tarifa aprobada ni un catálogo productivo:

| Comercial | Compatibilidad | Módulos base propuestos | Mes / año, céntimos sin IVA | Locales / miembros activos / claves / webhooks activos |
|---|---|---|---|---|
| Barra | reservas | reservations | 4900 / 46800 (39 €/mes equivalente) | 1 / 5 / 0 / 0 |
| Sala | sala | reservations, floor, kitchen | 9900 / 94800 (79 €/mes equivalente) | 1 / 15 / 1 / 1 |
| Grupo | completo | reservations, floor, kitchen, pos | 19900 / 190800 (159 €/mes equivalente) | 3 / 50 / 5 / 5 |

Prueba propuesta: 14 días, sin tarjeta. **Repite queda fuera de los tres módulos base comerciales**, activable como excepción por LogiQD hasta decidir su inclusión y precio. El `completo` antiguo sigue incluyendo todos los módulos para no cambiar restaurantes existentes silenciosamente. Los locales de Grupo pertenecen a un restaurante y una suscripción; no se introduce todavía otra capa de organización ni un catálogo compartido entre restaurantes.

`Subscription` guarda `planId,planVersion,status,interval,trialEndsAt,periodEndsAt,graceEndsAt,cancelAtPeriodEnd,stripeCustomerId,stripeSubscriptionId,revision`. `Entitlements` guarda `version,planId,planVersion,activeModules,moduleOverrides,limits,serviceEnabled,reason,evaluatedAt,nextEvaluationAt`. Backend proyecta en `restaurants/{rid}` el `plan` compatible, `commercialPlanId`, `commercialPlanVersion`, `entitlementVersion`, `moduleOverrides`, `activeModules`, en la misma transacción. `entitlementVersion` distingue una migración explícita: para esos restaurantes, faltar `activeModules` significa **ningún módulo**, nunca heredar `completo`. Para los antiguos se conserva exactamente el comportamiento de fase 1 hasta migrarlos con revisión y actividad. No se migra durante este encargo.

Las excepciones siguen siendo propiedad de LogiQD. En restaurantes antiguos `cambiarPlan` funciona como hasta ahora. En uno migrado, el backend debe rechazar esa entrada antigua con `failed-precondition` y «Este restaurante usa planes de plataforma. Revisa su suscripción y sus excepciones», antes de escribir; se usa `cambiarExcepcionesPlataforma`, que exige revisión y motivo. Elegir un plan en el asistente o pagar Billing **solicita** una oferta del catálogo: nunca escribe módulos desde el navegador. Webhook verificado o concesión de prueba del servidor calcula acceso. Una excepción de módulo no salta una suspensión. Las reglas deben seguir leyendo la misma proyección que UI y funciones.

`checkPlanLimit` se usa dentro de las transacciones de crear local, activar/invitar/reactivar miembro, crear clave y activar webhook. Cuenta miembros activos únicos por uid, no sumas por local; claves no revocadas y no caducadas, y endpoints activos o suspendidos (solo revocados liberan cuota). Se reservan contadores por restaurante para carreras; el panel de uso es una proyección y no autoriza altas. Un cambio a plan inferior con excesos se bloquea hasta elegir qué desactivar, sin borrar miembros ni locales automáticamente. `planOverages` identifica excesos; no fracciona ni borra datos. Repite exige además configuración del proveedor, aunque su módulo esté activo.

Alta: `onboardings/{id}` pertenece al uid autenticado, guarda `Onboarding` (`ownerUid,restaurantId,status,step,revision,requestId,error,trialUsed`) y `draft: OnboardingDraft` (`name,slug,location,settings,planId,planVersion,acceptedTermsVersion`). `guardarAlta` guarda un parche parcial validado por paso, con revisión esperada al modificar; solo cambia borradores propios `draft/failed`. `completarAlta` exige la revisión y valida el borrador completo y los términos antes de aprovisionar; usa el mismo requestId durante respuestas inciertas. En transacción reserva `restaurantSlugs/{slug}`, índice privado por uid de alta/prueba y límites, crea restaurante con plan explícito y proyección restrictiva, local, owner, índice de usuario, ajustes, prueba y actividad. Nunca depende solo de `slugify(name)`: un slug ocupado devuelve `already-exists`, con sugerencias que también se revalidan. El alta vieja `crearRestaurante` debe pasar por el mismo servicio antes de habilitar autoservicio, para no saltar cuotas, slugs o prueba única. No se concede otra prueba al repetir o borrar el borrador. Cuestiones de abuso entre identidades diferentes quedan pendientes antes de venta. Al fallar no queda restaurante parcialmente visible ni slug retenido sin recuperación. Las rutas públicas por slug conservan su significado.

**Ampliación aditiva de alta (fila Alta y Billing):** `OnboardingDraft` admite `floor?: {areaName,tableCount,seats}` y `menu?: {name,priceCents}[]`. Sin plano se crean seis mesas de cuatro plazas. El aprovisionamiento crea zona, mesas, horarios, ajustes de sala y estación de cocina en la misma transacción. Los platos opcionales quedan internos, sin pedido público y con alérgenos pendientes de revisión. No cambia ninguna firma existente ni migra restaurantes antiguos. Implementación y puntos de integración pendientes del coordinador en `functions/src/fase6-billing/README.md`.

### Estados de plataforma y Billing

| Entidad | Transiciones y significado |
|---|---|
| Alta | draft → provisioning/cancelled; provisioning → ready/failed; failed → provisioning/cancelled; ready y cancelled finales |
| Suscripción | not_configured → trialing/active/cancelled; trialing → active/past_due/suspended/cancelled; active → past_due/suspended/cancelled; past_due → active/suspended/cancelled; suspended → active/cancelled; cancelled final, un nuevo contrato crea otra intención |
| Prueba | trialing permite servicio estrictamente antes de trialEndsAt; al vencer pasa a suspended si no hay pago verificado |
| Impago | past_due conserva servicio hasta graceEndsAt; propuesta de gracia 7 días configurada en servidor, después suspended |
| Baja | cancelar programa cancelAtPeriodEnd, mantiene active hasta periodEndsAt; al vencer, cancelled. No borra datos ni fiscalidad |
| Trabajo de privacidad | requested → verified/blocked; verified → running/blocked; running → completed/blocked/failed; failed → running/blocked; blocked → verified; completed final |
| Entrega webhook | queued/retry → leased → delivered/retry/exhausted; cualquier pendiente → cancelled al revocar; delivered y cancelled finales |
| Copia / simulacro | copia running → verified/failed → expired por caducidad; simulacro requested → restoring → validating → passed/failed |

`subscriptionAllowsService` comprueba fechas exactas; `platformModules` combina catálogo y excepciones solo cuando hay derecho de servicio. El backend programa la siguiente evaluación, y las operaciones sensibles reevalúan al recibir, para no prolongar la prueba por un planificador parado. La implementación de reglas debe comprobar también el vencimiento de la proyección para que una lectura operativa no conserve acceso indefinidamente; `nextEvaluationAt` se proyecta como `accessValidUntil` en restaurante y se compara con `request.time`. `serviceEnabled: false` no impide a owner/manager ver plan, avisos, exportaciones y datos históricos autorizados por vías de solo lectura específicas. No se borra historial al apagar módulos; fiscal, reconciliación y RGPD siguen atendiendo obligaciones existentes. Antes de suspender con servicio en curso se avisa al propietario, se conservan los datos y se muestra la vía de continuidad manual; no se prometen escrituras desconectadas confirmadas.

Billing usa un **webhook entrante separado**, `stripeBillingWebhook`, sin modificar los de señales ni consumo. Comprueba firma y antigüedad con bytes originales, evento único, cliente/suscripción guardados, versión de precio, EUR, importe de la factura y estado de pago. La URL de vuelta de Checkout nunca activa módulos. Los ids de evento se deduplican transaccionalmente; un evento antiguo obliga a consultar el estado vigente del proveedor, no a sobrescribir el nuevo. Checkout y portal usan URLs de retorno de configuración del servidor y claves idempotentes, nunca URLs libres del cliente. Cambio comercial se aplica solo con confirmación del proveedor; el backend rechaza una bajada con excesos antes de solicitarla y reconcilia cambios hechos desde portal. No se mantiene transacción durante HTTP.

Sin claves o ids Price válidos: `not_configured` y «La facturación de la suscripción no está configurada. No se ha realizado ningún cargo». La prueba concedida localmente sigue siendo prueba, no pago ficticio. Credenciales separadas `STRIPE_BILLING_SECRET_KEY`, `STRIPE_BILLING_WEBHOOK_SECRET`; ningún acceso real durante esta fase local. Se prueban firmas y respuestas inyectadas, no Stripe real. `revision` impide que dos cambios comerciales pisen el mismo estado.

### Datos, autores y reglas que implementará cada agente

Documentos nuevos solo de servidor. Auth determina autor y permisos; los campos del cliente no conceden identidad. `createdAt,updatedAt` y `updatedBy` los escribe el servidor en decisiones autenticadas; todas las escrituras directas de cliente existentes conservan `updatedBy == request.auth.uid`. La cola local **no** se envía como escrituras Firestore pendientes. Los esquemas de lectura omiten metadatos y admiten Timestamp como fases anteriores; adaptadores `xxxForWrite` reciben conversor.

```
platformPlans/{planId}/versions/{version}    PlanDefinition, solo LogiQD por callable
restaurantSlugs/{slug}                      restaurantId, índice privado único
onboardings/{id}                            Onboarding + draft, solo servidor
onboardingKeys/{hash}                       uid, requestId, restaurantId, trialUsed; privado
platformRequests/{hash}                     actor, huella, respuesta, caducidad; privado
platformSupport/{id}                        actorUid, restaurantId, reason, openedAt, expiresAt; privado
platformRestaurantUsage/{rid}               UsageSnapshot, sin contactos ni importes detallados
billingEvents/{hash}                        estado y proveedor, privado
restaurants/{rid}
  commercialPlanId, commercialPlanVersion, entitlementVersion, accessValidUntil
  platform/subscription                    Subscription
  platform/entitlements                    Entitlements
  platform/usage                           contadores autoritativos y revisión
  billingIntents/{id}                       petición, estado externo y resultado; privado
  apiKeys/{keyId}                           ApiKey (hash, nunca token claro)
  webhookEndpoints/{endpointId}             WebhookEndpoint (sin secreto)
  webhookSecrets/{id}                       secreto por versión; privado
  platformEvents/{eventId}                  PlatformEvent inmutable, outbox transaccional
  webhookDeliveries/{id}                    WebhookDelivery, cuerpo congelado, solo servidor
  webhookAttempts/{id}                      respuesta sin credenciales, duración, intento; privado
  consents/{id}                             Consent inmutable + prueba privada referenciada
  privacyJobs/{jobId}                       PrivacyJob, páginas y cursores durables
  privacyTombstones/{id}                    identidades suprimidas con acceso restringido, sin contactos claros
  backups/{backupId}                        BackupManifest
  restoreDrills/{drillId}                    RestoreDrill
  locations/{lid}
    syncDevices/{deviceId}                  uid, active, lastSeenAt; no es otra identidad Auth
    syncStreams/{streamKey}                 actorUid, deviceId, lastSettledSequence, blockedCommandId|null
    syncReceipts/{key}                      CommandReceipt + autor y operación; privado
    syncResolutions/{id}                    comando, motivo y autor del descarte; inmutable
```

Storage privado: `platform/{rid}/exports/{jobId}/…` y `platform/{rid}/backups/{backupId}/…`. Sin descargas públicas permanentes ni tokens de Firebase expuestos. Exportación entrega URL firmada de un uso funcional y duración máxima 15 minutos, nunca después de `expiresAt`; requiere sesión y permiso para crearla. El almacenamiento usa cifrado y versión de clave externa al archivo. Manifiestos nunca contienen contactos ni secretos en claro. Las credenciales necesarias se guardan bajo custodia del servidor, no en la copia entregable al restaurante.

| Ruta / datos | Lectura cliente prevista | Escritura cliente |
|---|---|---|
| planes publicados y precios comerciales saneados | autenticado por callable; sin ids Stripe ni secretos | nunca |
| onboarding | solo su uid por callable | nunca |
| platform/subscription, entitlements y uso saneado | planes.ver, miembro activo; incluso suspendido | nunca |
| platformRestaurantUsage | claim logiqd por callable paginada | nunca |
| apiKeys y endpoints saneados, estados de entrega | integraciones.gestionar por callable; no hashes ni cuerpos privados | nunca |
| consents y privacyJobs saneados | privacidad.gestionar, miembro activo del restaurante, por callable | nunca |
| backups y restoreDrills saneados | claim logiqd por callable; propietario recibe estado, no ruta/clave de copia | nunca |
| streams, receipts, dispositivos, secretos, índices, trabajos, eventos, intentos, tombstones y pruebas de identidad | ninguna lectura directa SDK; backend autorizado | nunca |
| exports/backups en Storage | ninguna lectura directa SDK; exportación autorizada de vida corta | nunca |

Reglas deniegan todos los campos de plan/proyección nuevos en edición del restaurante, incluido `accessValidUntil`; no basta bloquear solo los tres de fase 1. Lectura operativa de módulos en restaurante migrado exige `request.time < accessValidUntil`. Conservar el acceso administrativo descrito requiere callables filtradas, no abrir Firestore al claim logiqd. El soporte exige claim, motivo y autorización temporal de hasta 60 minutos, registrada en actividad; no cambia claims ni suplanta al owner, no entrega claves, tokens o cuerpos personales por defecto. Acceder a contactos requiere justificación adicional y función explícita fuera de la API mínima de esta entrega. No se implementa un explorador Admin universal.

**Integración de la fase 6 (agente 5).** Cambios de contrato, mínimos y aditivos:

- `packages/core/src/modules.ts`: `RestaurantModulesLike` admite `accessValidUntil?: unknown` y `restaurantModules(restaurant, now?)` / `hasModule(restaurant, module, now?)` reciben un `now` opcional (por defecto `Date.now()`). En un restaurante migrado (`entitlementVersion` presente), pasada la fecha de `accessValidUntil` (Timestamp, Date o ms) no queda ningún módulo, igual que dicen las reglas. Así, un acceso vencido o suspendido corta reservas, sala, caja, personal e inventario en todos los escritores del servidor y en la interfaz, sin repetir una comprobación en cada uno, aunque el trabajador de suscripciones vaya por detrás. Los restaurantes antiguos no cambian.
- Cuota de personas: `invitarMiembro` reserva el hueco con `assertPlatformCapacity` (nueva persona o reactivación) y `changeMembership` lo libera con `releasePlatformCapacity` (nuevo, en `fase6-billing/context.ts`) al desactivar, en la misma transacción y sin bajar de cero. No existe todavía un escritor de servidor para crear locales: el SDK sigue sin poder crearlos ni borrarlos en restaurantes migrados.
- Eventos de plataforma, siempre con `enqueuePlatformEvent` en la transacción del hecho y con id determinista: `reservation.created` y `reservation.statusChanged` (reservas, lista de espera al aceptar la oferta, señal pagada y respuesta por WhatsApp; la sala los emite solo cuando la reserva cambia desde sala, no cuando lo hace Reservas), `order.placed` y `orderLine.statusChanged` (sala, en `Context.flush`), `payment.succeeded` (caja, en `Context.flush`, solo cobros) y `subscription.changed` (Billing, ahora por la cola común con `distributed: false`). El id de reserva usa `(restaurante, local, tipo, reserva, 'created' | largo del historial)`, el de pedidos y líneas `(restaurante, local, tipo, entidad, changeId)` y el de cobros `(restaurante, local, tipo, cobro)`. Un reintento recuperado por su recibo no vuelve a encolar.
- Reglas: el parche de Billing queda integrado en `firebase/firestore.rules` (módulos por `accessValidUntil`, `platformService` en plano, locales migrados solo por servidor), se retira la lectura de `restaurants/{rid}` por el claim `logiqd`, y `invoices` pasa a `allow get` con la restricción de privacidad y `allow list` sin ella (las reglas no pueden mirar otro documento por cada resultado de una consulta; la restricción efectiva de listados exige un campo en la factura y queda pendiente de decisión).
- Privacidad: los recuperadores de `orderSubmissions`, `posRequests` y `syncReceipts` rechazan con `failed-precondition` las filas con `privacyRedacted === true`, y `reservationChanged` no actúa sobre reservas con esa marca.


Permisos nuevos en `roles.ts`: `planes.ver` para owner/manager; `planes.gestionar` solo owner; `integraciones.gestionar` y `privacidad.gestionar` para owner/manager. Waiter, kitchen y bar no reciben ninguno. Sin conexión reutiliza exactamente permisos y módulos de fase 2, incluida estación propia y autorización por transición. No existe permiso general «offline» que los salte. API/Billing/RGPD no necesitan un módulo operativo para administración, pero una consulta API sí comprueba el módulo de su recurso.

### Callables y HTTP

Registradas en `CALLABLES`, `CALLABLE_SCHEMAS` y tipos genéricos, con `FASE6_ACCESS`. Entradas superiores estrictas y salidas ampliables; cuerpo y forma exactos en `api-plataforma.ts`. **R** = `restaurantId`; **M** = R + `requestId` estable de 16 a 100 caracteres; **V** = M + `expectedRevision`. Las mutaciones nuevas se deduplican por actor, restaurante, nombre y requestId; misma entrada recupera respuesta original, otra huella devuelve `already-exists`. El servidor sanea fichas anidadas antes de guardar. Operaciones de alta sin R se acotan al uid.

| Callable | Entrada | Salida | Quién |
|---|---|---|---|
| listarPlanesDisponibles | vacío | planes publicados sin ids Price | autenticado |
| listarIntegraciones | R, cursor, limit | claves sin hash/token, endpoints y entregas sin cuerpo, nextCursor | integraciones.gestionar |
| listarSolicitudesPrivacidad | R, cursor, limit | trabajos sin ruta privada/cursor de proceso, nextCursor | privacidad.gestionar |
| verContinuidad | R, cursor, limit | copias sin archivos/clave y simulacros sin destino, nextCursor | claim logiqd |
| guardarAlta | requestId, onboardingId|null, expectedRevision|null, step, draft parcial | onboardingId, onboarding | autenticado, solo borrador propio |
| completarAlta | requestId, onboardingId, expectedRevision | restaurantId, locationId, subscription, entitlements | autenticado, dueño del borrador |
| verSuscripcion | R | subscription, entitlements, plan | planes.ver |
| iniciarSuscripcion | V, planId, planVersion, interval | ready con url o not_configured con message | planes.gestionar |
| abrirPortalFacturacion | M | ready con url o not_configured con message | planes.gestionar |
| cancelarSuscripcion | V, reason | scheduled con endsAt o not_configured | planes.gestionar |
| guardarPlanPlataforma | requestId, plan | ok | claim logiqd; crea versión, nunca cambia usada |
| cambiarExcepcionesPlataforma | V, moduleOverrides, reason | entitlements | claim logiqd |
| sincronizarComando | command | receipt | autor Auth del comando, miembro y permisos actuales |
| recuperarComando | SyncScope, commandId | receipt|null | mismo autor y dispositivo autorizado; comprobación actual |
| descartarComando | command original, requestId, reason | receipt discarded | mismo autor autenticado; solo conflicto/rechazo o intención no aplicada verificada |
| listarRestaurantesLogiqd | cursor|null, limit 1…100, status | restaurants UsageSnapshot[], nextCursor | claim logiqd |
| verUsoPlataforma | R | UsageSnapshot | planes.ver |
| abrirAccesoSoporte | M, reason, durationMinutes 1…60 | supportAccessId, expiresAt | claim logiqd |
| crearClaveApi | M, name, scopes, locationIds, expiresAt | keyId, token, prefix | integraciones.gestionar |
| revocarClaveApi | M, keyId | ok | integraciones.gestionar |
| guardarWebhook | M, endpointId|null, url, events, locationIds, status | endpointId, secret|null, secretVersion | integraciones.gestionar |
| rotarSecretoWebhook | M, endpointId | secret, secretVersion | integraciones.gestionar |
| repetirEntregaWebhook | M, deliveryId, reason | deliveryId, status | integraciones.gestionar |
| registrarConsentimiento | M, customerId, purpose, status, policyVersion, evidenceId | consentId | privacidad.gestionar; evidencia real, nunca inventar consentimiento al importar |
| solicitarPrivacidad | M, customerId, kind export/erase, reason | jobId, job | privacidad.gestionar |
| verificarSolicitudPrivacidad | M, jobId, evidenceId | ok | privacidad.gestionar; identidad comprobada por canal acordado |
| descargarExportacionPrivacidad | R, jobId | url, expiresAt | privacidad.gestionar, trabajo propio del restaurante y completado |
| crearCopiaSeguridad | M, reason | backupId, manifest running | claim logiqd |
| simularRestauracion | M, backupId | drillId, drill requested | claim logiqd; destino aislado fijado en servidor |

Recuperar una respuesta con secreto mostrado una vez se permite al mismo actor e intención durante 24 horas en el registro privado cifrado; después se revoca/rota expresamente si se perdió, no se inventa el secreto. El token de API y el secreto webhook son 32 bytes aleatorios `linkToken`; la API solo guarda SHA-256. Los secretos webhook sí necesitan custodia recuperable para firmar; un hash solo no sirve. Los listados administrativos son paginados con cursor firmado y limitan cada colección incluida; no entregan hashes, cuerpos con secretos o rutas de Storage. Las ampliaciones de firmas pasan por coordinador.

HTTP real mínimo, Bearer con clave: `GET /v1/restaurants/{rid}/locations/{lid}/menu` (`menu.read`, floor, salida `ApiMenuOutput`) y `GET …/orders` (`orders.read`, floor, salida `ApiOrdersOutput`). Pedido API solo muestra id, hora, estado, total congelado e ids de líneas, sin notas ni contactos. No se promete escribir pedidos, inventario o clientes con scopes sin ruta. Cursor firmado por servidor incluye restaurante, local, filtro y última clave; se valida al paginar, orden `(placedAt,id)` y límite 100. Clave acotada a restaurante y locales explícitos; revocación/caducidad inmediata, cuota del plan, límite propuesto de 60 peticiones/minuto por clave y 300 por restaurante. Respuesta 401/403/409/429 según autenticación, permiso/módulo, conflicto y cuota. `lastUsedAt` no cambia la clave ni produce actividad por petición. Claves caducadas, otro local y campos no publicados tienen pruebas negativas.

### Sin conexión: protocolo y operaciones

La caché permite **consultar una copia con hora de última sincronización**, no afirmar que sea el estado actual. La PWA debe instalar/guardar su carcasa y los datos mínimos de servicio antes del corte; sin primera visita y sesión preparada no se promete arrancar sin internet. Persistencia local en IndexedDB por `(uid,restaurantId,locationId,deviceId)`, fuera de la caché HTTP compartida. No se cachean respuestas Auth, API privadas, facturas, tokens QR ni exportaciones en un service worker genérico. Salir bloquea y oculta inmediatamente el espacio local; si hay cola ofrece sincronizar o conservarla bloqueada para ese mismo uid con aviso visible, sin enviar jamás con la sesión del siguiente trabajador. No se elimina una intención incierta al limpiar pantalla. Borrados de sitio, modo privado, pérdida de dispositivo o falta de espacio pueden perder datos no sincronizados: el adaptador debe detectar fallo de persistencia antes de mostrar «guardado». No hay sincronización de caché entre tablets sin servidor local.

`OfflineCommand` contiene `actorUid,restaurantId,locationId,deviceId,commandId,sequence,clientCreatedAt,preconditions[{kind,id,version}],operation,payload`. La identidad declarada se compara con Auth; dispositivo es identificador de instalación, **no credencial que sustituya a Auth**. `commandId` aleatorio estable se asigna antes de enviar y `sequence` monotónica antes de confirmar guardado, ambos en una única transacción IndexedDB junto a la intención. Dos pestañas adquieren exclusión por el mismo almacén/lease. No se ordena por reloj cliente. `canonicalJson` y `commandFingerprint` ordenan claves de objetos, conservan orden de listas y rechazan valores no JSON. Hash incluye destino, autor, secuencia y fecha originales. Al reintentar no se edita nada de ese contenido.

Para dos intenciones locales sobre la misma entidad, una precondición puede llevar `afterCommandId` de un comando anterior del mismo flujo. El servidor resuelve su versión desde el recibo applied y sus versiones devueltas, sin modificar contenido ni huella del comando dependiente. Si el anterior fue descartado, no devolvió esa entidad o es de otro flujo, se produce conflicto; si otro dispositivo cambió la entidad entre ambos comandos, también. `resolveCommandPreconditions` prueba este encadenamiento.

Versiones son tokens opacos emitidos por el servidor en lecturas de sincronización. Deben cambiar al alterar campos relevantes de sesión, línea, tarea o agotados; no se usa `MenuItem.version` de precio como versión de agotado. El backend de fase 6 deberá añadir estas revisiones a **todas** las mutaciones pertinentes de fase 2 y entregar una proyección de sincronización autorizada. `preconditions` contiene todas las líneas de una acción masiva, o destino/tarea/plato de la intención. El servidor también comprueba estado y bloqueo de caja, propietario de tarea, referencias y permisos como las callables originales. No confía en que el cliente haya enumerado todas las dependencias.

| Pantalla | Permitido guardar localmente | Efecto pendiente y límites |
|---|---|---|
| Comandero | borrador existente y `enviarPedido`, `marcharPase`, `cambiarEstadoLineas`, `cambiarEstadoTarea`, `marcarAgotado` sobre entidades conocidas | no llega a cocina hasta confirmar. Destino y precios deben haberse revisado; no abre, mueve, une o separa sesiones ni crea recogidas públicas sin servidor |
| Cocina/barra | lectura preparada, empezar/listo/deshacer mediante cambiarEstadoLineas y agotados de su estación | cambio local pendiente, sala no lo ve; no se prepara una comanda que nunca llegó de otro dispositivo ni se cambia línea de otra estación |
| Caja | vista de última cuenta, borrador de reparto, prefactura claramente marcada y `OfflineCashNote` de efectivo entregado | no Payment, saldo liquidado, cajón automático ni factura fiscal. Al volver se revisa cuenta/parte/revisión, caja abierta y efectivo real antes de un registrarCobro online con clave estable |
| QR/cliente público | conserva borrador de fase 2 | sin nueva cola privilegiada; requiere conexión para pedir, pagar y enviar avisos |

`OFFLINE_PAYLOAD_SCHEMAS` reutiliza entradas existentes. En `enviarPedido` son obligatorios `requestId == commandId`, `expectedDestination`, `expectedPrices`, `expectedTotalCents`; no se aceptan precios definitivos del dispositivo. El servidor recalcula con carta vigente al sincronizar, no retrocede la carta a la fecha cliente. Agotado, precio cambiado o destino cerrado/movido son conflictos visibles; nada se sustituye ni recalcula silenciosamente aceptando otro total. Si un envío de fase 2 ya estaba en vuelo al adoptar la cola, se conserva su requestId y se recupera **primero** `orderSubmissions`; nunca se crea otra intención de fase 6 para la misma ronda.

Algoritmo transaccional de sincronización:

1. Autenticar, comprobar uid/dispositivo activo, membresía, local, módulo y permiso por operación/línea. La revocación no se puede conocer sin red; al reconectar detiene el envío, conserva incidencia y exige intervención autorizada.
2. Leer recibo por `offlineCommandKey`, que combina flujo e id. Misma huella devuelve resultado guardado **antes** de comparar versiones, destino o edad, incluso si ya se sirvió/cerró después. Otra huella produce `key_reused` sin sobrescribir ni ejecutar. La respuesta original de enviarPedido se coordina con `orderSubmissions`; todas las vías comparten el mismo servicio idempotente.
3. Leer cursor del flujo. Solo `lastSettledSequence + 1` se puede ejecutar. Hueco devuelve error transitorio sin guardar recibo definitivo ni adelantar cursor. Una secuencia ya consumida sin recibo es incidencia de integridad, no permiso para repetir. `inspectCommand` expresa estas decisiones; backend garantiza atomicidad y unicidad de secuencia e id. Orden entre dispositivos lo decide la transacción y sus precondiciones, no un reloj global.
4. Comparar versiones y todas las invariantes actuales, incluida cuenta bloqueada, tarea ampliada y agotados. Propuesta: intención de más de 24 horas o reloj cliente adelantado más de cinco minutos requiere revisión (`expired`), no se borra. Ejecutar todas las líneas o ninguna, usando la lógica y permisos originales. Efecto, revisiones nuevas, actividad, outbox y recibo se guardan **en la misma transacción**, nunca ejecutando primero una callable fuera y guardando el recibo después.
5. Un efecto aceptado guarda `applied` con respuesta validada por `OFFLINE_OUTPUT_SCHEMAS` y versiones nuevas, avanza cursor. Las respuestas de dominio `rejected` de carta y `taken` de tarea se convierten en `conflict` (`price_changed`, `unavailable`, `task_taken`); no se guardan como éxito. Conflicto/rechazo conserva recibo, bloquea cabeza y el resto del flujo. Cancelar explícitamente usa descartarComando y actividad: compara intención, verifica que no se aplicó y avanza cursor con resolución `discarded`. Se preserva el conflicto original en `syncResolutions`. Nunca se permite descartar una respuesta aplicada ni un resultado incierto sin consultarlo en servidor.
6. Resolver exige leer estado actual, explicar diferencia y aceptar de nuevo; nueva intención con **nuevo id** al final del flujo y condiciones actuales. Las posteriores que dependían del conflicto pueden a su vez requerir revisión; no se reescriben automáticamente. Cambiar de rol/autor para reenviar una intención no está permitido.

`LocalQueueEntry` guarda `command,state,attempts,nextAttemptAt,result,lastError`. Estados: queued → sending → applied/conflict/rejected; pérdida de respuesta → uncertain; fallo transitorio → retry/uncertain → sending, siempre mismo id. Al recargar, todo sending pasa a uncertain, se consulta recuperarComando y, si no hay recibo, se reenvía el mismo contenido. `nextLocalCommand` devuelve solo la primera intención no aplicada/descartada del flujo; conflicto, rechazo o sending bloquean las siguientes. `retryLocalCommand` mantiene contenido y aplica espera exponencial 1…60 s; el adaptador corta reintentos automáticos tras 12 fallos y ofrece reintentar al reconectar, conservando la intención. Errores permanentes no reintentan a ciegas. Recibos no caducan durante esta fase; las respuestas de comandos no contienen secretos. Antes de introducir caducidad hace falta una barrera duradera que impida que una clave vieja vuelva a ejecutar.

Textos exportados `OFFLINE_MESSAGES` para mantener el significado: «Guardado en este dispositivo. Pendiente de sincronizar. Cocina y caja aún no lo han recibido»; cocina: «Cambio guardado en este dispositivo. Sala aún no lo ha recibido»; incierto: «No sabemos si se ha confirmado. Recuperaremos la respuesta del mismo envío»; conflicto: «Los datos han cambiado. Revisa el conflicto antes de continuar». Tarjeta: **«Necesitas conexión para cobrar con tarjeta. No se ha realizado ningún cargo»**. Fiscal: **«Necesitas conexión para emitir una factura fiscal. Esta vista es una prefactura sin número fiscal»**. Efectivo: «Anotación local de efectivo pendiente de revisar. No confirma el cobro ni emite una factura». No se muestra «enviado», «pagado» o «facturado» por una persistencia local.

No se hace sin conexión: alta/planes/roles, conciliación de saldo, cobro con tarjeta o Stripe, aplicar señales/devolver, emitir/rectificar/anular fiscalmente, cerrar arqueos, imprimir fiscal con numeración inventada ni restaurar copias. Un datáfono independiente puede tener sus propias capacidades, pero Llenamos no las acredita ni registra como cobro confirmado sin validación online. Esta fase no promete facturación autónoma local ni una pasarela entre sala y cocina durante caída total de internet; alternativa operativa de corte: comunicación y anotación manual con conciliación posterior.

### Implementación de Panel LogiQD y API (fila 3)

El módulo `functions/src/fase6-api/` entrega sus exports al coordinador, sin modificar el índice común, reglas ni navegación. `UsageSnapshot` amplía de forma opcional y aditiva su proyección saneada con `activeModules`, `moduleOverrides`, `legacyPlan` y `platformRevision` para que el equipo vea módulos reales y pueda usar la revisión al editar excepciones. `listarIntegraciones` amplía opcionalmente su salida con `workerLastRunAt` y `lastAttemptAt` en las entregas para distinguir trabajadores nunca ejecutados y medir el último intento. No incluye contactos. `pendingCommands` mide flujos bloqueados que ya conoce el servidor; no puede contar intenciones que aún solo existen en tablets. `measuredAt` identifica la antigüedad y el trabajador se ejecuta explícitamente en local. Detalles de integración y límites en `functions/src/fase6-api/reglas.md`.

**Implementación (fila Sin conexión).** Callables añadidas, sin cambiar ninguna firma congelada: `sincronizarComando`, `recuperarComando`, `descartarComando` y `prepararSinConexion`. Esta última: entrada estricta `SyncScope + entities[{kind,id}]` (máximo 100); salida `{versions: ServerEntityVersion[], contentHashes:[{kind,id,hash}], synchronizedAt: ms}`; solo el uid de Auth, miembro activo con acceso al local y módulos actuales; cocina y barra solo reciben líneas y platos propios; sin datos personales. Cada escritor de fase 2 que pasa por `context.put` añade `syncRevision` (solo servidor); el token combina revisión y huella del contenido normalizado, y sesiones y tareas incorporan sus líneas relacionadas. Los escritores futuros de otras fases que cambien sesiones, líneas, tareas o carta deben emitir revisiones con el mismo servicio. En el navegador la cola vive en IndexedDB con Web Locks (sin Web Locks no se habilita) y `/sw-plataforma.js` (importa `/sw-avisos.js`) sirve una carcasa pública de recuperación sin guardar HTML autenticado. Caja guarda `OfflineCashNote` y nunca un `Payment` desconectado; la conciliación pasa por la callable de caja con `noteId` como `requestId`.

### Eventos, API y webhooks salientes

`PlatformEvent` inmutable: `id,type,version:1,restaurantId,locationId|null,occurredAt,data{entityId,status|null}`. Eventos **comprometidos**: `reservation.created`, `reservation.statusChanged`, `order.placed`, `orderLine.statusChanged`, `payment.succeeded`, `subscription.changed`, `privacy.completed`. Solo se emiten al confirmar esos hechos, en su transacción, con id determinista por decisión/revisión. Sus productores deben conectarse realmente en reservas, sala, caja, Billing y privacidad; el catálogo solo no constituye una integración. Cuerpo mínimo por referencia, sin contacto, alergias, notas, tokens ni datos fiscales completos. Se filtran eventos por restaurante y local del endpoint; eventos sin local solo para suscripciones del restaurante autorizadas al crearlas. Nuevos eventos o alcances pasan por contrato.

`WebhookDelivery` congela `endpointId,eventId,body,bodyHash,status,attempts,nextAttemptAt,leaseUntil,lastStatus,lastError`. Id `webhookDeliveryId(endpointId,eventId)` evita entregas creadas dos veces. El worker reclama con lease, registra cada intento, timeout de 10 s y máximo 12 intentos. 2xx confirma, 429/5xx/red permiten reintento; 410 revoca destino, otros 4xx exigen revisión. `nextWebhookAttempt` espera 30 s y duplica hasta 6 h. Agotado se suspende endpoint, conserva historial y permite repetición manual con motivo; repetir entrega conserva **mismo eventId y body**, reinicia presupuesto en otra ronda auditada, nunca crea otra reserva o cobro. El receptor deduplica `event.id`: HMAC no evita repetición por sí solo.

Cabecera `Llenamos-Signature: t=<segundos UTC>,v1=<hex HMAC SHA-256>` sobre **`t + "." + cuerpo UTF-8 exacto`**. `signPlatformWebhook` y `verifyPlatformWebhook` prueban firma y tolerancia de ±300 s, sin parsear/reordenar el cuerpo antes de verificar. Cada reintento lleva fecha/firma nuevas; el evento no cambia. Comparación de longitud fija en core; backend puede usar timingSafeEqual. Se rota secreto con versión; worker relee versión vigente antes de firmar y nunca registra secreto. Receptor conserva ids vistos. Billing usa protocolo Stripe propio, no este encabezado.

El servidor valida destinos HTTPS y bloquea loopback, redes privadas, link local, metadatos, puertos no permitidos y redirecciones; vuelve a resolver/verificar DNS en cada conexión para impedir SSRF y cambios de resolución. `z.url` no prueba esto. En emuladores los envíos salen solo a un receptor **local permitido explícitamente** de la fila del agente mediante transporte de prueba inyectado; nunca se permite desactivar esa protección en producción. Las pruebas de core no hacen HTTP. Los endpoints de salud y el panel muestran pendientes, último intento, proveedor no configurado y trabajadores detenidos con hora de medición; no anuncian entrega por encolar.

### RGPD: inventario de copias, exportación y borrado

El inventario `PERSONAL_DATA_KINDS` cubre cliente, reserva, espera, recogida, sesión, comanda, línea, tarea, mensaje, actividad, solicitud idempotente, recibo, checkout, fidelización, exportación y fiscal. El adaptador servidor encuentra referencias **por customerId y enlaces exactos** de reserva/sesión/recogida/cuenta, además de destinatario normalizado en mensajes sin referencia. Debe inventariar también secretos privados de seguimiento y notificaciones, importaciones, evidencias de consentimiento y datos de versiones futuras antes de habilitarlas. No se borran datos de otra persona por coincidir nombre o por buscar texto libre sin verificar contexto.

| Copia | Qué revisar al exportar y borrar |
|---|---|
| customers | nombre, contactos, idioma, notas, alergias, etiquetas, historial de métricas; eliminar ficha e índice por teléfono, registrar tombstone restringido |
| reservations, waitlist, takeaways | contacto, guestNotes/notes, customerId, tokens, referencia y secretos de enlaces; anonimizar histórico o eliminar espera, revocar enlaces |
| tableSessions, orders, orderLines, floorTasks | guestName, cliente enlazado, comensal, notas y peticiones de llamada; limpiar texto personal y desvincular con tombstone, conservar cantidades e importes operativos |
| messages | to, data, rendered, providerMessageId y errores que puedan repetir contacto; cancelar queued y borrar contenido/destinatario elegible; conservar solo evidencia técnica mínima |
| activity, orderSubmissions, posRequests, platformRequests y syncReceipts | resúmenes/metadatos y respuestas replicadas; saneamiento de datos personales sin perder barrera idempotente ni atribución operativa necesaria, con evento de redacción separado para auditoría inmutable |
| digitalReceipts, mobileCheckouts, takeawaySecrets, enlaces de reserva/espera | correo, receptor, consentimiento y secretos; revocar acceso y borrar copias no sujetas a conservación; no alterar originales fiscales |
| consents, fidelity/Repite, exportaciones y backups | historial de permisos y bajas, retirada en proveedor cuando exista, borrar artefactos al caducar y aplicar tombstone en restauración |
| invoices, fiscalRecords, fiscalResponses y cadenas | conservación restringida según política aprobada; no modificar originales ni hash/encadenamiento para aparentar borrado total |

`Consent` es un evento con `customerId,purpose,status,policyVersion,at,source,evidenceId`. Propósitos separados `marketing_email`, `marketing_whatsapp`, `digital_receipt`. Mensajes operativos de reserva no dan permiso de marketing. `hasCurrentConsent` ordena por fecha de servidor y en empate gana withdrawn; importar contactos no crea permisos. Backend comprueba consentimiento al encolar **y antes de enviar** una campaña, cancela pendientes al retirar y coordina proveedores externos. Nada de esto implica que Repite o campañas estén implementados en esta entrega.

`exportCustomerData` recibe proyecciones `PersonalDataRecord` ya saneadas, filtra restaurante/persona y ordena; los campos personales admitidos son name, phone, email, notes, allergies y tags, sin objetos arbitrarios ni tokens. Es un **componente** del exportador, no un volcado completo ni una promesa de cumplimiento por sí solo. El exportador de implementación debe añadir histórico pertinente, reservas, consumo, pagos/facturas que correspondan, consentimientos y evidencia de conservación, con adaptadores de lista explícita, sin exponer datos de terceros ni secretos. Identidad verificada antes de ejecutar, artefacto privado y descarga caducable; un trabajo con relaciones sin resolver queda blocked, nunca completed parcial.

`planCustomerErasure` devuelve acciones por copia: keep para operaciones vivas (bloquea finalización y se reintenta al cerrar), restricted para fiscal o retención justificada, delete para cliente/espera/mensaje/export y anonymize para histórico operativo. `anonymizePersonalRecord` limpia la proyección personal; **el backend debe trasladar esos cambios a todos los campos reales y retirar referencias enlazantes**, no guardar solo esta proyección. Libre texto ambiguo exige revisión de encargado y bloqueo visible; no se supone anónimo por dejar customerId a null. El pseudónimo residual necesario para idempotencia es restringido, no anonimización irreversible prometida. Se crean tombstones, se cancelan avisos, se revocan enlaces y se registra auditoría mínima sin repetir datos borrados. Procesamiento por páginas, checkpoints y operaciones idempotentes; reintentar no resta métricas ni borra datos ajenos.

`RetentionPolicy`: `provisional,operationalDays,messageDays,exportHours,backupDays,fiscalDays|null`. Propuesta técnica inicial: 365 días operativos inactivos, 90 mensajes, 24 h exportaciones, 30 días copias. **No son plazos legales aprobados** ni justifican conservar todo hasta el máximo. `fiscalDays: null` impide purga automática fiscal hasta política validada; `retentionDecision` nunca borra originales fiscales ni registros con legalHold. Alergias y notas se minimizan y revisan especialmente por su sensibilidad. Una petición de borrado puede adelantar eliminación no restringida; se informa qué se conserva, por qué y hasta cuándo. Plazos de atención, bases jurídicas, contrato encargado/responsable, política pública y transferencias de proveedores requieren revisión del propietario antes de vender. No se declara cumplimiento por disponer de un botón.

### Copias, restauración y trabajadores

Copia coherente por **un restaurante**, incluyendo subcolecciones, proyecciones públicas y slug, membresías/índices de usuario compartidos sin sobrescribir otros restaurantes, archivos referenciados, facturas y artefactos, cadenas/cabezas, recibos idempotentes, tombstones y colas. La copia de datos no contiene contraseñas/Auth ni credenciales productivas; el procedimiento documenta cómo reconciliar uids y referencias con Auth en el destino de prueba, sin recrear cuentas de otro inquilino. Se fija corte consistente mediante mantenimiento por restaurante o exportación coherente del proveedor; copiar colecciones durante escrituras sin barrera no cuenta como snapshot. Restauración valida schemaVersion, hashes SHA-256, número de registros y archivos exactos (`checkBackupFiles`), relaciones, aislamiento, cadena fiscal y totales antes de habilitar servicio.

`BackupManifest`: `restaurantId,schemaVersion,snapshotAt,status,files[{path,sha256,bytes,records}],encrypted:true,keyVersion,expiresAt`. `RestoreDrill`: `restaurantId,backupId,status,startedAt,completedAt,isolatedTarget,outboundDisabled:true,checks{hashes,counts,fiscalChains,tenantIsolation,privacyTombstones,outboxes},measuredRpoMs,measuredRtoMs,error`. `restoreDrillPasses` exige todos los controles y tiempos medidos dentro de objetivos; `restoreDrillDue` exige como máximo 30 días entre simulacros. Objetivos propuestos, **no SLA demostrado**: RPO 24 h, RTO 4 h. Capturar desde inicio de recuperación hasta verificación terminada, no solo duración de lectura de archivos; conservar evidencia del simulacro mensual.

Primero se restaura en destino aislado `demo-llenamos`, sin emisores de correo, WhatsApp, Stripe, Hacienda, impresoras ni webhooks externos. No se asignan números nuevos ni se reconstruyen cadenas desde facturas modernas. Se aplican los tombstones vigentes **posteriores** al snapshot antes de exponer datos, para no resucitar contactos suprimidos. Retención de copia inmutable se comunica y su eliminación física sigue el plazo configurado. Slug y rutas públicas solo se conmutan tras validar y dentro de una barrera de mantenimiento. Restauración productiva es un procedimiento separado con revisión del propietario; `simularRestauracion` nunca acepta un proyecto o ruta libre del cliente.

`restoredOutboxDisposition` no reenvía ciegamente colas: pagos/fiscal/webhooks desconocidos se reconcilian con el proveedor mediante el mismo id; mensajes/impresión inciertos pasan a revisión humana; efectos confirmados quedan hechos. Se conservan índices y recibos contra duplicados, reservas de pago y cabezas. La restauración de un backup anterior al último cobro **no** puede usar el snapshot solo como verdad del saldo: necesita diario posterior y consulta externa antes de abrir caja. No se anuncia recuperación completa sin esa reconciliación.

| Proceso y propietario | Garantía y ejecución local |
|---|---|
| Alta/Billing: evaluación de acceso y Stripe | transacción con evento/actividad; vencimientos revalidados en cada escritura y worker explícito de suscripciones |
| Sin conexión: recepción y recuperación | misma transacción que servicio, recibo y cursor; integra revisiones y módulos/roles con fase 2 y caja |
| Panel/API: productores de eventos y distribución | outbox transaccional; fanout y worker con lease, ids estables y reintento acotado; métricas con measuredAt |
| Copias/RGPD: privacidad/retención | trabajos paginados idempotentes; no purgar fiscal ni servicio vivo; evidencia de permisos y saneamiento de copias |
| Copias/RGPD: snapshot/simulacro | copia diaria propuesta y simulacro mensual, métricas RPO/RTO y cuarentena de colas |

Programadores no corren solos en emuladores: cada agente entrega un script local que invoca exactamente el mismo worker, restringido a demo y puertos de su fila. Estado de salud distingue nunca ejecutado, última ejecución y fallo. Ningún worker debe hacer llamadas a proveedores reales en estos recorridos. Actividad administrativa y eventos operativos se escriben con la decisión, usan changeId para evitar duplicados y resúmenes sin contacto, secretos o datos fiscales completos.

### Implementación de Copias y RGPD (fila 4)

Sin cambios en `packages/core` ni en firmas congeladas. `functions/src/fase6-privacy/` y `functions/src/fase6-backup/` entregan sus exports, reglas e índices como datos en sus `reglas.md`; la pantalla `/panel/privacidad` solo existe para `privacidad.gestionar` con acceso a todos los locales. Datos añadidos solo de servidor (todos denegados por SDK): `privacyEvidence` (atestación humana de identidad con caducidad), `privacyRequests`, `privacyDownloads` (ticket de un uso, hash), `privacyHealth`, `backupRequests`, `backupHealth`, `privacyRestrictedInvoices` (índice de lectura restringida de facturas conservadas) y el prefijo `restoreSandbox/**` del simulacro. El registro de jornada (`timeEntries`, `shifts` y afines) y toda la cadena fiscal quedan fuera de la supresión y la caducidad, y entran en las copias. Credenciales (`webhookSecrets`, `pushSubscriptions`, `staffPins`) nunca entran en la copia; tras restaurar se rotan. Los plazos son los provisionales del contrato y el procedimiento, con lo que cubre y lo que no, está en `docs/operacion/plataforma/copias-y-privacidad.md`. La clave de custodia local es `PLATFORM_DATA_KEY_V1` (32 bytes en base64); sin ella nada se cifra ni se escribe.

### Core, pruebas y decisiones abiertas

`planes.ts`: catálogo, cuotas, transiciones de alta/suscripción, acceso y adaptadores. `sin-conexion.ts`: esquemas por operación, clave/huella canónica, cola, reintento, recuperación tras recarga, precondiciones encadenadas, clasificación de respuestas de dominio y decisión de cursor, mensajes y anotación de efectivo. `integraciones.ts`: scopes, modelos de eventos y claves, HMAC, verificación temporal y espera de entregas. `privacidad.ts`: inventario, permisos por propósito, trabajos, proyección de exportación, plan de borrado y retención. `continuidad.ts`: manifiesto, simulacro, validación y destino de colas restauradas. Todo exportado desde `@llenamos/core`; `api-plataforma.ts` registra 29 callables y dos lecturas HTTP. Las pruebas cubren fronteras de vencimiento/cuota, compatibilidad, roles, aislamiento de cola, respuesta perdida, bloqueo de orden, versiones, HMAC con vector RFC y Node, firma alterada/caducada/futura, consentimiento retirado, persona ajena, protección fiscal y simulacro incompleto.

La entrega de contrato no necesita emuladores ni capturas porque no modifica servidor, reglas ni pantallas. Los cuatro implementadores deberán probar navegador con emuladores reales, caída/recarga/reconexión y dos dispositivos, además de integración y reglas de su ámbito. La prueba local sin conexión tiene que demostrar persistencia tras recarga y fallos de IndexedDB, nunca solo `navigator.onLine = false`.

| Decisión o duda para propietario | Recomendación |
|---|---|
| Alinear Barra/Sala/Grupo, límites y precios con landing (decisión 5) | validar tabla provisional antes de publicar catálogo o vender; catálogo versionado y sin Price real hasta entonces |
| Repite (decisión 8) | opcional apagado en ofertas nuevas hasta decidir precio y proveedor; conservar planes antiguos con migración explícita |
| Prueba, gracia y abuso de nuevas cuentas | 14 días sin tarjeta, 7 de gracia, una prueba por titular comprobado; revisar mecanismo de identidad antes de autoservicio público |
| Qué significa servicio sin internet | cola de intenciones sobre sesiones conocidas y comunicación manual entre dispositivos; no prometer servidor local, tarjeta o fiscalidad sin conexión |
| Efectivo durante un corte | anotación pendiente con entrega y revisión humana online; no cerrar saldo/arqueo ni emitir numeración local |
| Organización y catálogo de varios restaurantes | fase 6 limita Grupo a varios locales del mismo restaurante; ampliar organización/catálogo en contrato posterior si el primer cliente lo necesita |
| Soporte de LogiQD y dispositivos compartidos | diagnóstico mínimo con claim, motivo y caducidad; no suplantar ni guardar datos de otro uid accesibles en la tablet |
| Retención, alergias y originales fiscales | revisar inventario/plazos con asesor y proveedor fiscal antes de automatizar purgas; informar conservación restringida |
| Objetivos de recuperación y proveedores | validar RPO 24 h/RTO 4 h en simulacro medido mensual, elegir almacenamiento/custodia y diario posterior antes de prometer SLA |

El reparto exclusivo de implementación está al final de `docs/tareas/fase-6-reparto.md`. Firmas/core se congelan al integrar este contrato; cualquier ampliación pasa por coordinador.

## Restaurante de demostración (`pnpm seed`)

- Restaurante `demo-lumbre`: **Taberna Lumbre** (inventado), color `#f0a35e`, `isDemo: true`.
- Local `centro` en «Carrer de la Lumbre 12, Barcelona».
- Zonas: Sala (10 mesas) y Terraza (6 mesas), con posiciones en el plano 0–100 sin solapes, plazas de 2, 4 y 6, una mesa de 8 en Sala, formas rectangulares y redondas, parejas y un trío unibles con enlaces simétricos en la misma zona y una mesa deshabilitada en Terraza.
- Cuentas (contraseña común `Llenamos2026!`): `propietario@lumbre.test` (owner), `encargada@lumbre.test` (manager), `camarero@lumbre.test` y `camarera@lumbre.test` (waiter), `cocina@lumbre.test` (kitchen), `barra@lumbre.test` (bar).
- Nombres de las cuentas en ese orden: Marta Soler, Laura Vidal, Diego Ríos, Lucía Ferrer, Pau Serra y Nora Costa.
- El seed es idempotente: ejecutarlo dos veces no duplica nada.

## Panel del personal (`apps/web`)

- Rutas: `/entrar` y `/panel` (Inicio), `/panel/sala`, `/panel/equipo`, `/panel/actividad`, `/panel/ajustes`. Las dos zonas cuelgan del grupo `app/(personal)`, que es donde vive la sesión.
- La sesión es de Firebase Auth en el navegador: no hay cookie ni `proxy`. El panel protege sus páginas en el cliente y las reglas de Firestore lo vuelven a comprobar en cada lectura. Por eso el layout y las páginas del panel llevan `instant = false`.
- El rol que manda es el de `restaurants/{rid}/members/{uid}`; `users/{uid}.restaurants` solo sirve para la lista de restaurantes. Quien tiene `locationIds` no vacío lee sus locales uno a uno (las reglas no le dejan pedir la colección entera).
- Los documentos se validan con los esquemas de `@llenamos/core`; si uno no encaja, la interfaz dice cuál y qué campos, en vez de rellenar nada.
- Las funciones se llaman con `getFunctions(app, "europe-west1")`, validando antes la entrada con zod y con 20 segundos de espera como máximo.
- Fase 1 (R4): `/panel/plano`, `/panel/horarios`, `/panel/mensajes` y `/panel/compartir`; las tres últimas solo con el módulo `reservations`. El menú oculta lo que el rol no puede o el plan no trae, y la página lo vuelve a comprobar. `/logiqd` (fuera de `/panel`) es para quien tiene el claim `logiqd` y cambia el plan con `cambiarPlan`.
- Código del widget que enseña `/panel/compartir` (lo sirve R5): `<script src="{origen}/widget.js" data-llenamos-slug="{slug}" async></script>`, o un iframe a `{origen}/widget/{slug}`. El enlace público es `{origen}/r/{slug}`. El origen sale de `NEXT_PUBLIC_SITE_URL` y, si no está, del navegador.

## Diseño

Mismo aspecto que la web de venta (`apps/landing`): modo oscuro cálido, fondo `#131209`, superficies `#181818` y `#1f1f1f`, acento ámbar `#f0a35e`, verde `#8fc7a0` para «sentados/correcto», rojo cálido `#e8857a` para errores, texto `#f4f1ea`, texto apagado `#a39f95`. Logo: una mesa vista desde arriba con cuatro sillas y «llenamos» en minúscula, con «by LogiQD» en apagado (`components/Wordmark.tsx`; favicon en `app/icon.svg` y `app/favicon.ico`). Tipografía Geist (y Geist Mono para cifras). Iconos de Phosphor. Curva de animación `cubic-bezier(0.32, 0.72, 0, 1)`. Interfaz en castellano, sin guiones dentro de las frases, frases en minúscula inicial normal (no Title Case).

Componentes: shadcn/ui en `apps/web/src/components/ui` y piezas propias en `components/common`, montados con bloques de registros (no recreando el lienzo de `docs/diseno`, que solo es referencia de marca). Guía, origen y licencia de cada pieza en `docs/diseno/componentes.md`; muestra viva en `/panel/muestra`.

## Reglas de trabajo

- TypeScript estricto. Nada de `any` sin un comentario que lo justifique.
- Comentarios y textos de interfaz en castellano.
- No añadas dependencias sin necesidad; si lo haces, dilo en tu informe final.
- Cada parte termina con sus pruebas en verde: `pnpm --filter <paquete> typecheck`, `lint` y `test`.
- Nada se simula en silencio: si algo no está configurado, la interfaz lo dice.

## Proveedores de R2 (fase 1, solo verificados en local)

Variables de servidor: `RESEND_API_KEY` y `EMAIL_FROM` (Resend); `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` (WhatsApp Cloud API); `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (Checkout y firma HMAC); `PUBLIC_APP_URL` (origen HTTPS de la web para Checkout y enlaces). No se guardan credenciales en el repositorio. Sin claves del canal: `captured` con texto renderizado únicamente en emulador, `not_configured` fuera. Stripe y WhatsApp no se han probado contra servicios reales; WhatsApp interactivo requiere ventana de atención abierta, y faltan las plantillas aprobadas para iniciar conversaciones fuera de ella. Detalles y comandos en `functions/README.md`.

Las ofertas vigentes consumen capacidad como reservas pendientes sin mesa mediante `offeredOccupancy` (R2). Las comprobaciones transaccionales de disponibilidad de R1 y R2 ya incluyen esas ocupaciones y comparten el bloqueo de reservas. Aceptar la oferta revalida disponibilidad y crea una reserva transaccional. El enlace de oferta es `/r/[slug]/lista-espera/[waitlistId]?t=...`.

El procesador usa campos internos `claim` y `leaseUntil` en los mensajes, ignorados por el esquema de lectura, para excluir envíos concurrentes. `r2RateLimits` y `r2WebhookEvents` son colecciones internas solo de servidor. El webhook de WhatsApp comprueba la firma, el teléfono del remitente y el mensaje respondido. El webhook de Stripe comprueba firma, antigüedad, sesión, importe, moneda y pago completo; no reabre reservas canceladas ni realiza reembolsos automáticos.

La responsabilidad de cancelar y programar avisos por cambios de reserva pertenece a la transacción que realiza el cambio: R1 y los webhooks de R2 comparten esa preparación. El disparador `mensajesReservaActualizada` solo programa reseñas con id determinista y activa la lista de espera al liberar capacidad; no reescribe avisos, evitando carreras con `change()` y `moverReserva`. R1 y R2 comparten el ayudante de bloqueo y la ocupación de ofertas vigentes; aceptar excluye la oferta propia y crea el índice privado de referencias.

### Cierre local de los pendientes de fase 1

Lista de espera verificada con los emuladores: cancelación por el personal, primera entrada compatible, enlace en el mensaje capturado, capacidad retenida durante `offerMinutes`, aceptación con reserva e índice de referencia, rechazo de enlaces falsos y repetidos, caducidad y oferta a la siguiente persona. Chromium abre el enlace capturado completo y comprueba la aceptación y la caducidad.

Señal verificada con clave ficticia únicamente dentro de las pruebas y `fetch` de Checkout simulado. Cargas HTTP firmadas por HMAC contra `stripeWebhook` cubren firma buena, mala, repetida y caducada, importe y moneda incorrectos, pago completo y confirmación una sola vez, y pago tardío sin reabrir una reserva cancelada. Sin clave, la reserva queda `pending` con `deposit.status: "not_configured"`; Chromium comprueba que la web lo explica y no ofrece pagar. **No se ha probado contra Stripe real ni se ha realizado ningún pago.**

Importar admite CSV y la primera hoja de `.xlsx`, sin dependencias nuevas. El navegador lee ZIP con `DecompressionStream("deflate-raw")`, cadenas compartidas y en línea, fórmulas con valor guardado, celdas vacías y fechas y horas de Excel de los sistemas 1900 y 1904. No calcula fórmulas ni lee `.xls`, `.xlsb`, `.ods`, libros cifrados o ZIP64. La pantalla limita el archivo a 5 MB y el lector limita cada parte a 50 MB durante la descompresión, valida tamaños y rechaza columnas fuera del límite de Excel. Si falta la API del navegador, pide CSV. Las reservas siguen pasando por la validación de core y del servidor.

Los índices de grupo de colección para `waitlist.status`, `messages.status` y `messages.providerMessageId` están en `firebase/firestore.indexes.json`. Reproducción, resultados y revisión de las seis alertas de Dependabot en `docs/tareas/fase1-pendientes-validacion.md`.
