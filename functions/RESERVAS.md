# Backend de reservas (R1)

Las doce callables de R1 están en `src/reservations.ts`. Usan las entradas y salidas de core, comprueban permisos y módulos dentro de transacciones, y reservan capacidad aunque no haya mesa asignada. Las altas del personal necesitan teléfono igual que las públicas.

`src/messages/enqueue.ts` es la frontera con R2. No envía: crea mensajes validados, con fechas de Firestore. Sin Stripe, una señal requerida deja la reserva pendiente y marca `not_configured`. El token solo se devuelve al crear y se incluye en el enlace del mensaje inicial. Las rutas privadas auxiliares y los campos de `data` se describen en `ARQUITECTURA.md`.

## Comprobación local

Instala con `pnpm install --frozen-lockfile --prefer-offline`. Compila con `pnpm funciones:build`. Copia `firebase.json` a una configuración temporal excluida en el archivo de exclusiones de Git y configura los puertos de R1 del reparto. No reutilices los puertos del coordinador.

En PowerShell, configura Java 21 y las variables:

```powershell
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-21.0.13.21-hotspot'
$env:PATH="$env:JAVA_HOME\bin;$env:PATH"
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8096'
$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9102'
$env:FUNCTIONS_EMULATOR_HOST='127.0.0.1:5012'
$env:GCLOUD_PROJECT='demo-llenamos'
$env:TEST_FIREBASE_EMULATORS='1'
pnpm exec firebase emulators:exec --project demo-llenamos --config firebase.r1.json --only firestore "vitest run --root tests/rules"
pnpm exec firebase emulators:exec --project demo-llenamos --config firebase.r1.json --only auth,firestore,functions "pnpm --filter functions exec vitest run && pnpm exec tsx scripts/check-seed.ts"
```

El segundo comando ejecuta también las pruebas de integración heredadas. Comprueba concurrencia pública, choques de mesa, transiciones, permisos, módulos, señal con y sin variable configurada (sin llamadas a Stripe), mensajes, proyección pública y estadísticas de cliente. Si se indica `FUNCTIONS_EMULATOR_HOST`, prueba además disponibilidad por HTTP. El seed se ejecuta dos veces y se comparan documentos y fechas.

La integración de proveedores, ofertas y webhooks pertenece a R2. Debe leer e incrementar el bloqueo privado del local al consumir capacidad. La cancelación no devuelve dinero automáticamente. La proyección pública agrupa los locales que aceptan reservas; las políticas detalladas se comprueban siempre con la configuración del local seleccionado. Por ahora las transacciones leen las reservas del local completas; convendrá acotar las consultas cuando haya histórico de producción.
