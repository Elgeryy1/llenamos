# Evidencia local del backend de fase 5

10 de noviembre de 2026. Chromium con `deviceScaleFactor: 2`, Auth 9102, Firestore 8096 y Functions 5012 de demo. Sin servicios reales. No se ha editado `apps/web`: las pantallas de producto pertenecen a los otros agentes.

- `sesion-real.png`: acceso al panel real con `propietario@lumbre.test` y la cuenta del seed, desde `/entrar`.
- `backend-escritorio.png`: diagnóstico de respuestas HTTP reales a 1440 px de ancho, imagen a 2880 px.
- `backend-tableta.png`: mismo diagnóstico a 1024 px, imagen a 2048 px.
- `backend-movil.png`: mismo diagnóstico a 390 px, imagen a 780 px.
- `resultado.json`: respuestas de puntos, canje, repetición idéntica del requestId, tarjeta en cola, previsión y panel. Sin token de Auth ni contactos.
- `disparadores.json`: resultado del recorrido posterior con los disparadores reales habilitados y el doble HTTP de Repite: 40 puntos al liquidar, 10 menos al devolver y un solo sello para la visita sentada y cobrada.

Las tres imágenes de diagnóstico se renderizan en el navegador después de llamar al backend; son un informe de prueba, no capturas de las futuras pantallas de producto. El canje pasa de 120 a 40 puntos y descuenta 700 céntimos una sola vez. El informe de ventas enseña siete cuentas cobradas por 52 500 céntimos; la previsión devuelve sus muestras reales y confianza. La tarjeta estaba pendiente al hacer las capturas y el trabajador local la creó después en el doble.

## Repetir el navegador

Evidencia histórica del backend anterior al cierre. El recorrido integrado actual está en [fase5](../fase5/README.md) y su preparación en [el README del backend](../../../../functions/src/fase5/README.md). Para reproducir este diagnóstico, adaptar los puertos originales a la fila propia y usar la entrada común con todos los módulos exportados. La web usa únicamente los emuladores de la fila 1:

```sh
cd apps/web
NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-llenamos NEXT_PUBLIC_FIREBASE_API_KEY=demo-api-key \
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=demo-llenamos.firebaseapp.com \
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=demo-llenamos.appspot.com NEXT_PUBLIC_FIREBASE_APP_ID=demo-app-id \
NEXT_PUBLIC_USE_EMULATORS=1 NEXT_PUBLIC_EMULATOR_HOST=127.0.0.2 \
NEXT_PUBLIC_AUTH_EMULATOR_PORT=9102 NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT=8096 \
NEXT_PUBLIC_FUNCTIONS_EMULATOR_PORT=5012 NEXT_PUBLIC_STORAGE_EMULATOR_PORT=9212 \
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3011 \
node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3011
```

Desde la raíz, `pnpm exec tsx scripts/fase5-verificar.ts node --import tsx scripts/fase5-navegador.ts`. El script usa el Playwright compartido y Chromium indicados en el reparto, crea una cuenta ficticia de prueba para el recorrido y solo añade saldo de demostración si hace falta repetir el canje. Contraseña de las cuentas del seed: `Llenamos2026!`. Parar la web y los emuladores al terminar.
