# Lo que Llenamos espera de la API de Repite

Documento para el repositorio `LogiQD/repite`. Describe la API que Llenamos necesita para el módulo opcional `repite` (fase 5). **Esta API no existe todavía.** Repite es hoy un prototipo con sus pilotos en `datos/datos.json`; pasar a una base de datos para muchos locales y publicar esta API es trabajo de ese repositorio, no de Llenamos. Mientras tanto, Llenamos usa un doble local en pruebas y emuladores (`createLocalRepite` en `packages/core/src/fidelizacion/repite.ts`) y fuera de ellos responde «Repite no está conectado». Nadie de Llenamos llama al Repite real hasta que esta API esté publicada y probada.

La interfaz del lado de Llenamos es `RepiteAdapter` (mismo archivo). Este documento es su traducción a HTTP. Si Repite decide otra forma, se cambia aquí y en el adaptador a la vez; la interfaz de core es lo que manda dentro de Llenamos.

## Qué hay hoy en Repite (leído en el repositorio, noviembre de 2026)

- Servidor `node:http` sin framework (`servidor.js`), datos en un JSON, un negocio por entrada de `config.js` o creado desde HQ.
- `GET|PUT /api/hq/negocios…`, `GET /api/hq/estado`, `POST /api/hq/negocios/{id}/avisos` e informe: API para HQ con un token (`REPITE_TOKEN_HQ`). Sirve para dar de alta y editar negocios, no para tarjetas de clientes.
- `POST /api/{negocio}/clientes` crea una tarjeta con un nombre (lo usa la página del cliente), `/api/c/{código}` lee la tarjeta y pide sello, y el panel del negocio (con PIN) da sellos, canjea y ve el informe.
- Reglas: como mucho un sello cada 4 horas por tarjeta (el dependiente puede saltárselo), avisos con límite de uno programado por semana, de 10:00 a 20:00 y no más de 2 en 24 horas, e informe del mes frente al anterior.

Lo que falta para Llenamos: autenticación de máquina a máquina por integrador y comercio, claves de idempotencia, referencia externa del cliente, sello ligado a una visita y no a un toque, borrado por privacidad y almacenamiento para muchos comercios.

## Principios

1. **Repite es la fuente de verdad** de tarjetas, sellos, premios y avisos. Llenamos solo guarda `merchantId`, `cardId` y su propia referencia opaca del cliente.
2. **Datos mínimos.** Llenamos manda una referencia aleatoria (`externalRef`, de 16 a 64 caracteres `[A-Za-z0-9_-]`) y el nombre de pila para la tarjeta. Nunca teléfono, correo, alergias ni el id interno del cliente.
3. **Idempotencia en todo lo que cambia algo.** Cabecera `Idempotency-Key` (hasta 200 caracteres). La misma clave con el mismo cuerpo devuelve la respuesta original con `duplicate: true`; con otro cuerpo, `409 idempotency_conflict`. Repite guarda las claves al menos 30 días.
4. **Una visita, un sello.** El sello lleva `visitKey` (la misma al sentar y al cobrar la misma visita en Llenamos). Repite no da dos sellos para el mismo `visitKey` en el mismo comercio, aunque cambie la clave de idempotencia.
5. **Errores claros y sin inventar.** Si Repite no puede hacer algo, lo dice con un código; Llenamos nunca enseña un sello como dado sin la respuesta `2xx`.

## Autenticación y comercios

- `Authorization: Bearer <token>`: un token de servicio por integrador (Llenamos), guardado en el servidor de Llenamos (`REPITE_API_TOKEN`), nunca en un navegador ni en un repositorio. Rotación sin corte: dos tokens válidos a la vez durante el cambio.
- Cada token solo puede tocar los comercios que LogiQD le haya asignado en Repite. Un `merchantId` ajeno responde `403 merchant_not_allowed`, sin decir si existe.
- `merchantId`: identificador estable del comercio en Repite (`[a-z0-9-]{2,60}`). En Llenamos lo fija solo el equipo de LogiQD (`vincularRepite`).
- Base propuesta: `https://repite.logiqd.me/api/v1`. Solo HTTPS. Respuestas JSON UTF-8. Instantes en ms UTC.

## Endpoints

| Operación | Método y ruta | Cuerpo | Respuesta |
|---|---|---|---|
| Crear tarjeta | `POST /merchants/{merchantId}/cards` | `{ externalRef, displayName, language: "es"\|"ca"\|"en" }` | `201 { cardId, saveUrl\|null }`. Si ya hay tarjeta con ese `externalRef` en el comercio: `200` con la misma |
| Dar sello | `POST /merchants/{merchantId}/cards/{cardId}/stamps` | `{ visitKey, trigger: "seated"\|"paid"\|"manual", occurredAt }` | `201 { stampId, stamps, stampsForReward, rewardReady, duplicate: false }`; repetido: `200 { …, duplicate: true }` |
| Leer tarjeta | `GET /merchants/{merchantId}/cards/{cardId}` | | `200 { cardId, status: "active"\|"removed", stamps, stampsForReward, rewardsAvailable, inWallet, lastStampAt\|null }` |
| Aviso «te echamos de menos» | `POST /merchants/{merchantId}/cards/{cardId}/notices/we-miss-you` | `{}` | `200 { status: "scheduled"\|"rate_limited"\|"not_in_wallet", noticeId\|null, duplicate }` |
| Informe del mes | `GET /merchants/{merchantId}/reports/{AAAA-MM}` | | `200 { month, visits, newCustomers, returningCustomers, rewardsRedeemed, noticesSent, returnedAfterNotice, previous\|null }` |
| Borrar tarjeta (privacidad) | `DELETE /merchants/{merchantId}/cards/{cardId}` | | `200 { removed: true, duplicate }`; la tarjeta deja de actualizarse en el Wallet y sus datos se borran según la política de Repite |
| Salud | `GET /health` | | `200 { ok: true, version }`, sin token |

Notas:

- `saveUrl` es el enlace firmado para guardar la tarjeta en Google Wallet (o Samsung Wallet). Puede caducar; Llenamos lo pide de nuevo con `GET` si hace falta (puede venir también en la lectura, como campo opcional).
- `trigger: "manual"` es un sello que da a mano el personal en Llenamos; Repite puede saltarse su espera mínima entre sellos en ese caso, igual que hoy desde su panel. Con `seated` o `paid`, un sello demasiado seguido responde `409 stamp_too_soon`.
- Si un sello no cabe (por ejemplo, un sello doble con la tarjeta casi llena), Repite aplica su regla actual (guardarlo para la siguiente) y lo refleja en `stamps` y `rewardReady`.
- El aviso respeta los límites de Repite y de Google (uno por semana y cliente, de 10:00 a 20:00). Llenamos además manda como mucho uno por cliente y día y no lo manda a quien retiró su permiso de marketing.
- El informe es del mes en la zona horaria del comercio. `previous` es el mismo informe del mes anterior, o `null` si no hay datos.

## Errores

Cuerpo `{ "error": { "code": "…", "message": "texto en castellano" } }`.

| HTTP | `code` | En Llenamos (`RepiteErrorCode`) | ¿Se reintenta? |
|---|---|---|---|
| 400 | `invalid_request` | `invalid` | no |
| 401 | `unauthorized` | `unauthorized` | no |
| 403 | `merchant_not_allowed` | `unauthorized` | no |
| 404 | `card_not_found` | `not_found` | no |
| 409 | `stamp_too_soon`, `idempotency_conflict`, `card_removed` | `conflict` | no |
| 429 | `rate_limited` (con `Retry-After`) | `rate_limited` | sí, tras la espera |
| 5xx o sin respuesta en 10 s | `unavailable` | `unavailable` | sí |

Llenamos reintenta con la **misma** `Idempotency-Key`: a los 30 s, doblando hasta 6 horas y como mucho 12 veces. Después la operación queda fallida y visible para el encargado, que puede reintentarla a mano con la misma clave.

## Lo que Repite tendría que tener antes de conectar Llenamos

- Base de datos para muchos comercios (en vez del JSON), con copias y restauración probadas.
- Tabla de claves de idempotencia y unicidad de `(merchantId, visitKey)` y de `(merchantId, externalRef)` comprobadas en la misma transacción que el sello o el alta.
- Tokens por integrador y asignación de comercios por LogiQD, con registro de quién hace qué.
- Borrado por privacidad de una tarjeta y retirada del Wallet.
- Un entorno de pruebas (o datos de prueba separados) para comprobar la integración sin tocar tarjetas reales; `npm run demo` hoy borra las reales y no sirve para esto.
- Límite de peticiones razonable para un restaurante en hora punta (propuesta: 10 por segundo por comercio) y tiempo de respuesta por debajo de 2 s.

## Lo que no se pide

- Que Repite sepa de reservas, mesas, importes o platos: solo recibe la visita como `visitKey`.
- Que Repite mande correos o WhatsApp: los avisos de Repite son los del Wallet. Las campañas por correo o WhatsApp las hace Llenamos con su propio permiso.
- Webhooks de Repite hacia Llenamos. Si más adelante hacen falta (tarjeta guardada en el Wallet, premio canjeado en el mostrador), se firmarán como los webhooks de la fase 6 y se añadirán a este documento.
