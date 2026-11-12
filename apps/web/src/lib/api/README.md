# Transporte VPS: primera frontera, no migración completa

`NEXT_PUBLIC_DATA_BACKEND=postgres` selecciona explícitamente la API same-origin
`POST /api/v1/operations/:name`. El proxy debe quitar `/api`: el servidor recibe
`/v1/operations/:name`. Entrada `{ data }`, salida `{ result }`, error
`{ error: { code, message, requestId } }`. Privadas con ID token Firebase en `Authorization`;
públicas sin token ni cookies. No hay redirecciones, fallback a nube ni tokens en URL.

Las fronteras adaptadas son `lib/data/callables.ts`, `lib/data/functions.ts` y
`lib/publica/callables.ts`. Conservan validación Zod de entrada y salida.
La aceptación de una invitación es pública y nunca envía la identidad anterior.
`auth-client.ts` inicializa solo identidad; lo utilizan sesión, login y restablecimiento.
El selector es público y queda incorporado al compilar Next, como las otras `NEXT_PUBLIC_*`.

`AuthProvider` observa únicamente Auth. `PanelData` en modo VPS obtiene
`GET /api/v1/session` y `GET /api/v1/restaurants/:rid/context`; sus respuestas son objetos
JSON directos, sin el envoltorio de operaciones. Permisos, membresías, restaurante y
locales proceden de SQL y se validan con Zod y el UID/RID esperado. El panel no monta
listeners de Firestore en este modo. Un cambio de cuenta o restaurante oculta el estado
anterior; desmontar cancela su petición y salir cancela las peticiones privadas activas.
Esta primera lectura no sustituye todavía las suscripciones realtime de cada módulo.

Mientras se migra cada módulo, el backend anterior solo se admite para `demo-*` con emuladores
explícitos y selector ausente o `firebase-demo`. Una configuración real sin `postgres` falla
cerrada. No activar `postgres` en la publicación hasta que las operaciones estén portadas:
la API devuelve 404 para operaciones no implementadas, sin fingir compatibilidad.

Los wrappers de caja, análisis, compras, campañas, fidelización, personal, sala,
cocina y carta también apuntan a la API: véase [su alcance y operaciones pendientes](OPERATIONS.md).
Siguen pendientes las lecturas Firestore/onSnapshot, escrituras directas y el protocolo
offline. El cliente legacy solo inicializa datos
para emuladores `demo-*`: cualquier ruta pendiente falla cerrada en VPS antes de crear
Firestore/Functions. Persisten imports del SDK en los módulos pendientes y la rama demo;
esta capa no certifica que el producto completo ya funcione solo con Auth.

## Tiempo real

`useLiveQuery(name, input, schema)` (`live.ts`) abre `POST /api/v1/live/:name` por `fetch` (SSE, token en
cabecera) y devuelve `Live<T>`. `live-stream.ts` lleva la reconexión (1 s a 30 s con variación),
`Last-Event-ID`, latido de 45 s y errores definitivos (`permission-denied`, `unauthenticated`,
`not-deployed`…), que se enseñan en vez de reintentarse. Salir o cambiar de cuenta cancela las conexiones
(`cancelIdentityRequests`). `useApiRestaurantContext` ya es una lectura en vivo (`contextoRestaurante`).
Los ganchos de `lib/config/hooks.ts` piden `ajustesReservas` y `mensajesRecientes` en el VPS: hasta que
reservas y avisos las registren responden `not-deployed`. Contrato del servidor: `apps/api/src/live/README.md`.
