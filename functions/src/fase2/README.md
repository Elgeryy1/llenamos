# Backend de sala y cocina

Las 31 callables de `CALLABLE_SCHEMAS_FASE2` se exportan desde `functions/src/index.ts`. La ampliación de carta incorpora tres callables de QR y campos opcionales descritos en ARQUITECTURA.md. El seed principal llama a `seedFase2`.

Cada operación valida Auth, membresía, local, módulos y permiso antes de preparar escrituras. Los cambios de preparación comprueban cada línea y su estación. El contexto lee los documentos antes de escribir y usa `reservationLocks/current` también para sala. La integración de reservas y lista de espera usa las sesiones actuales para la ocupación, sin contar dos veces las reservas sentadas representadas.

Los precios se calculan con la carta leída en la transacción. La aprobación conserva los precios enviados. Las contribuciones de gasto guardan el importe absoluto por destino y aplican solo la diferencia al cliente. Cerrar registra consumo, sin afirmar que esté pagado. Las tareas mantienen su dueño y plazo al ampliarse, moverse o dividirse.

Los contadores públicos por IP y token o teléfono se confirman en una transacción independiente para contar también los intentos fallidos. Admiten 60 solicitudes por minuto y no guardan el token claro. La validación de QR y destino sigue dentro de la transacción del pedido.

La proyección pública se reconstruye desde los documentos actuales y usa un bloqueo por local. Los disparadores de reconciliación también leen el estado actual y no repiten gasto ni recrean recogidas de una entrega antigua. Las callables escriben su actividad y `changeId` en la operación original; el disparador omite esas escrituras.

## Ejecución local del agente 3

Crear `firebase.agente3.json` copiando `firebase.json` con los puertos de la fila 3. En este worktree el websocket interno de Firestore usa 3013, pues el backend no levanta una web. Solo se usa `demo-llenamos`.

```sh
pnpm funciones:build
npx firebase emulators:start --project demo-llenamos --config firebase.agente3.json
```

Con los emuladores arrancados, en otra terminal:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8098 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9104 pnpm seed
GCLOUD_PROJECT=demo-llenamos FIRESTORE_EMULATOR_HOST=127.0.0.1:8098 pnpm exec tsx scripts/procesar-recogidas.ts demo-lumbre centro
GCLOUD_PROJECT=demo-llenamos TEST_FIREBASE_EMULATORS=1 FIRESTORE_EMULATOR_HOST=127.0.0.1:8098 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9104 FUNCTIONS_EMULATOR_HOST=127.0.0.1:5014 pnpm --filter functions test
FIRESTORE_EMULATOR_HOST=127.0.0.1:8098 FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9214 pnpm exec vitest run --root tests/rules
```

Las reglas limpian Firestore y Storage: nunca ejecutarlas a la vez que integración o seed. Para la comprobación aislada de Firestore, parar primero la suite anterior y ejecutar:

```sh
npx firebase emulators:exec --project demo-llenamos --config firebase.agente3.json --only firestore "vitest run --root tests/rules"
```

El coordinador debe añadir a `package.json` el script `"sala:procesar": "tsx scripts/procesar-recogidas.ts"`. El procesador local y la función programada usan exactamente `processTakeaways`, sin callable administrativa pública. No hay dependencias nuevas.

Las fotos se leen con `getBlob` o `getBytes`, usando autorización de Storage. El frontend no debe crear enlaces permanentes mediante `getDownloadURL`. Las reglas solo publican la ruta referenciada por un plato activo, y permiten editar fotos a propietario y encargado con acceso al local y módulo de sala.

La lectura transaccional reúne el servicio del local y la carta. Antes de trabajar con historiales grandes conviene acotar esas consultas y archivar servicios antiguos. Los índices incluidos cubren las consultas por estación, estado, destino y hora que necesitan las pantallas.

## Verificación de esta entrega

Se han ejecutado `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, 25 pruebas de integración de fase 2 y 78 pruebas de reglas de Firestore y Storage. También se ha ejecutado el procesador local. La integración cubre apertura concurrente, reserva sentada, precios manipulados, menús con suplementos, tokens de otra mesa y local, aprobación, dueño único, movimiento, unión, separación, recogida, gasto idempotente y seed.

Limitación operativa del entorno de ejecución: al interrumpir el arranque de emuladores con `npx`, quedaron sus hijos en los puertos propios, sin PID accesible desde las sesiones siguientes. El reinicio mediante `emulators:exec` falló por esos puertos ocupados. Las suites anteriores se ejecutaron correctamente contra los emuladores que ya estaban activos. Hay que detener esos procesos desde la sesión anfitriona y repetir el comando aislado antes de integrar. No se han usado puertos de otros agentes ni servicios reales.
