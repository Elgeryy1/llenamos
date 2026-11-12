# Copias y RGPD · capturas

Recorrido real en el navegador (Chromium, 2x) con los emuladores de la fila 1 (demo-llenamos), cuenta `propietario@lumbre.test` y la ficha sintética «Celia Demo privacidad». Sin proveedores reales. Resultados del recorrido en `navegador.json`.

| Captura | Qué muestra |
|---|---|
| `01-solicitud-escritorio.png` | Consentimiento dado y retirado, solicitud de exportación registrada una sola vez aunque se pierda la respuesta del servidor |
| `02-exportacion-lista.png` | Identidad verificada, trabajador ejecutado y descarga disponible con caducidad |
| `03-confirmar-borrado.png` | Aviso antes de pedir el borrado: lo fiscal se conserva restringido |
| `04-borrado-terminado.png` | Exportación y borrado terminados; la ficha ya no existe |
| `05-privacidad-movil.png` | Misma pantalla a 390 px, sin desbordes |

La descarga usa un enlace de un solo uso: el segundo intento devuelve 403. Las copias y el simulacro de restauración no tienen pantalla propia (los ve el equipo de LogiQD); su evidencia está en `docs/operacion/plataforma/simulacro-local.json`.

## Repetir

```bash
# emuladores con la custodia local de la fila 1 (crea /tmp/llenamos-copias-key-v1)
npx tsx scripts/copias-entorno.ts npx firebase emulators:start --project demo-llenamos --config firebase.agente1.json
export METADATA_SERVER_DETECTION=none GCLOUD_PROJECT=demo-llenamos FIRESTORE_EMULATOR_HOST=127.0.0.1:8096 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9102 FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9212 PLATFORM_DATA_KEY_V1=$(cat /tmp/llenamos-copias-key-v1)
pnpm seed && pnpm seed:servicio && npx tsx scripts/privacidad-demo.ts
(cd apps/web && npx next dev -p 3011)        # en otra terminal
npx tsx scripts/privacidad-navegador.ts      # genera estas capturas
npx tsx scripts/copias-demo.ts               # copia, simulacro cronometrado y simulacro-local.json
```

Aviso: un documento de restaurante con datos inválidos hace caer los disparadores del emulador de funciones y puede colgar las pruebas de integración. Para estas, bastan `--only auth,firestore,storage`.
