# Clientes, marketing y análisis integrados

Las 39 callables y los procesos de fase 5 están exportados por `functions/src/index.ts`. Los escritores de reservas guardan origen y consentimiento en su transacción; el procesador común comprueba el permiso al reclamar el mensaje y WhatsApp reconoce las palabras de baja. El inventario de privacidad de fase 6 cierra puntos, anonimiza movimientos y encola la retirada Repite antes de eliminar el enlace. No hay disparadores duplicados.

## Reproducción local en la fila 2

Solo `demo-llenamos`. Sin proveedores ni pagos externos y sin dependencias nuevas. La configuración ignorada se genera copiando `firebase.json`, incluida su sección functions:

```sh
pnpm exec tsx scripts/fase5-config.ts
pnpm funciones:build
REPITE_API_URL=http://127.0.0.1:5013/demo-llenamos/europe-west1/repiteLocal REPITE_API_TOKEN=local \
PUBLIC_APP_URL=http://localhost:3012 STRIPE_BILLING_WEBHOOK_SECRET=whsec_solo_fixtures_locales \
pnpm exec tsx scripts/fase5-verificar.ts npx firebase emulators:start \
  --project demo-llenamos --config firebase.agente2.json
```

El lanzador fija Auth 9103, Firestore 8097 y Storage 9213; conserva una clave local de 32 bytes fuera del repositorio para las pruebas de custodia. La interfaz de Firebase se desactiva: el websocket de diagnóstico de Firestore usa 4012 para no ocupar un puerto ajeno a la fila. Hub 4412, Logging 4512, Eventarc 9312, Tasks 9512. La web usa 3012 y las variables de `.env.example` con los puertos de la fila 2. Abrir `localhost`, permitido por Next en desarrollo.

Pausar los disparadores solo para cargar la historia inventada; activarlos antes del recorrido:

```sh
node -e "fetch('http://127.0.0.1:4412/functions/disableBackgroundTriggers',{method:'PUT'})"
pnpm exec tsx scripts/fase5-verificar.ts pnpm seed
pnpm exec tsx scripts/fase5-verificar.ts pnpm seed:servicio
pnpm exec tsx scripts/fase5-verificar.ts pnpm exec tsx scripts/seed-fase3.ts
pnpm exec tsx scripts/fase5-verificar.ts pnpm exec tsx scripts/seed-fase4.ts
pnpm exec tsx scripts/fase5-verificar.ts pnpm exec tsx scripts/seed-fase5.ts
pnpm exec tsx scripts/fase5-verificar.ts pnpm exec tsx scripts/fase5-navegador-integracion.ts
```

El seed de fase 5 se carga después del base, que vuelve al plan sala. No reinicia saldos, cupos ni programas ya creados. Los trabajadores programados no corren solos en el emulador: `scripts/fase5-trabajadores.ts` ejecuta sus mismas implementaciones. Repite rechaza destinos remotos; el doble HTTP pierde su memoria al reiniciar Functions.

## Comprobaciones y evidencia

Recorrido y capturas de producto a 2x en [fase5](../../../docs/diseno/capturas/fase5/README.md). El diagnóstico original del backend se conserva, con sus puertos y resultados originales, en [fase5-backend](../../../docs/diseno/capturas/fase5-backend/README.md). No representa la interfaz del producto.

Ejecutar `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Las suites de integración necesitan `TEST_FIREBASE_EMULATORS=1`, `GCLOUD_PROJECT=demo-llenamos` y los hosts de la fila. Para Billing HTTP, `FUNCTIONS_PORT=5013` y el secreto ficticio del arranque. Las pruebas de privacidad y copias se ejecutan con `--only auth,firestore,storage` y `PLATFORM_DATA_KEY_V1`, sin disparadores; las de reservas y sellos, con Functions activo. Comandos y resultados del cierre en el README de fase5.
