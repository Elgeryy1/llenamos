# Impresoras y puente local

Capturas reales de `/panel/impresoras`, con Chromium y emuladores de la fila 1 (`demo-llenamos`), propietario de Taberna Lumbre, `pnpm seed` y `pnpm seed:servicio`. Escala 2x: escritorio 1440 × 900, tableta 1180 × 820 y móvil 390 × 844. Sin desbordamiento horizontal en móvil. El indicador flotante de desarrollo de Next se oculta en las capturas; no se oculta información del producto ni se modifican los estados.

- `escritorio.png`: impresora de caja y comanda de cocina, estaciones y últimos trabajos.
- `editar.png`: edición con perfil 58/80 mm, puente, estaciones y cajón.
- `tableta.png` y `movil.png`: distribución adaptable del mismo panel.
- `en-cola.png`: prueba real solicitada en la interfaz, pendiente del puente.
- `incierto.png`: servidor TCP falso que recibe bytes pero no confirma cierre remoto; el puente devuelve incierto, sin reenvío.

Se han usado formularios y callables reales para editar una impresora, renovar su credencial, dar de alta otra por estación e imprimir pruebas. No se ha utilizado una impresora física. El servidor TCP falso guarda y compara los bytes. Las facturas de prueba conservan «no válido para Hacienda». Ninguna captura contiene credenciales ni tokens de lease.

Para repetir el arranque, instalar el puente y aplicar las exportaciones, reglas, índices y menú pendientes de integración, consulta [el README del puente](../../../../tools/print-bridge/README.md). La superposición de reglas se ha cargado únicamente en el emulador con `functions/src/fase3-print/rules.integration.test.ts`; no se ha editado `firebase/**`.

Pruebas específicas: `node --test tools/print-bridge/bridge.test.mjs`; integración con `TEST_FIREBASE_EMULATORS=1 GCLOUD_PROJECT=demo-llenamos FIRESTORE_EMULATOR_HOST=127.0.0.1:8096 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9102 pnpm --filter functions exec vitest run src/fase3-print/`. Recorrido HTTP y transporte: `scripts/impresion-e2e.ts`. El QR del raster ESC/POS de ambos anchos se ha decodificado con un lector independiente de prueba (`jsQR`, solo en `/tmp`) y recupera exactamente la URL fiscal original.

No se ha probado el backend de caja de la otra rama, envío fiscal real ni hardware. El coordinador debe integrar exportaciones, navegación, reglas e índices antes de dar por conectado todo el producto.

Comprobaciones finales: comandos comunes en verde, integración completa de Functions con emuladores recién arrancados (138 pruebas), integración específica de impresión (23), reglas del repositorio (78) y puente TCP (7). Los procesos propios están detenidos. Instalación, menú, reglas, índices y mensaje de commit propuesto están en el README enlazado.
