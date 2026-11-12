# Sin conexión

La fila implementa IndexedDB por uid, restaurante, local y dispositivo; asignación atómica de secuencia e intención; exclusión entre pestañas con Web Locks; recuperación de `sending` como `uncertain`; consulta del recibo antes de repetir; reintentos limitados; conflictos persistentes y descarte explícito con motivo y autor. Un navegador sin Web Locks no habilita la cola. Los fallos de almacenamiento nunca se presentan como guardado.

`executeInContext` extrae el servicio existente de fase 2, sin ejecutar una callable fuera de la transacción. La sincronización comparte permisos, módulos, estados, raciones, precios, bloqueos de caja, actividad y `orderSubmissions`. El recibo y el efecto se guardan juntos. El puente antiguo se consulta antes de revisar edad, destino o versiones. Misma clave con otra huella se rechaza; los recibos no caducan.

Todos los escritores que pasan por `context.put` generan `syncRevision` opaca. El token añade una huella del contenido normalizado para detectar escritores antiguos que aún no emitan revisiones. Sesiones y recogidas incluyen sus líneas; las tareas incluyen sus líneas relacionadas. Así una marcha masiva comprueba también dependencias que el cliente haya omitido. La proyección auxiliar solo prepara versiones cuya huella coincide con los datos que muestra la pantalla. No actualiza silenciosamente las condiciones de una intención existente.

Comandero, cambios de pase, líneas, tareas y agotados pasan por la cola también en línea. En cocina solo se permiten los cambios de su estación y los recuentos de raciones siguen requiriendo conexión. Una cola pendiente queda oculta y bloqueada para cualquier otro uid. Salir conserva las intenciones y bloquea también la carcasa de recuperación.

Caja guarda `OfflineCashNote`, nunca un Payment desconectado. La conciliación requiere revisión humana, datos frescos, caja seleccionada y la callable existente de caja. Antes de enviarla guarda su payload inmutable y usa `noteId` como requestId. La bandeja superior permite recuperar la misma respuesta aunque la cuenta haya quedado saldada y desaparecido de la lista. No se duplica el libro de caja. Los errores de revisión siguen visibles y no se descarta efectivo automáticamente.

## Integración reservada al coordinador

No se han editado `functions/src/index.ts`, navegación, Firebase común, reglas, índices, configuración versionada, `ARQUITECTURA.md`, `PLAN.md` ni core congelado. No hay dependencias nuevas ni entradas nuevas de menú.

1. Reexportar desde `functions/src/index.ts`:

   ```ts
   export { sincronizarComando, recuperarComando, descartarComando, prepararSinConexion } from './fase6-sync'
   ```

2. En el registro existente de avisos, usar `/sw-plataforma.js` con el mismo scope `/panel/`. El worker nuevo importa `/sw-avisos.js` y conserva push y notificaciones. No registrar dos workers competidores para el mismo scope. El registro global sigue siendo propiedad del coordinador; el script de navegador instala manualmente el worker nuevo para comprobarlo, sin editar ese registro.
3. Trasladar a la sección de fase 6 de `ARQUITECTURA.md` el siguiente añadido de implementación y registrar la proyección auxiliar en el catálogo de core si se mantiene pública:

   > `prepararSinConexion`: entrada estricta `SyncScope + entities[{kind,id}]`, máximo 100; salida `{versions: ServerEntityVersion[], contentHashes:[{kind,id,hash}], synchronizedAt: ms}`. Solo el uid de Auth, miembro activo con acceso al local y módulos actuales. Cocina y barra solo obtienen líneas y platos propios. No devuelve datos personales. Cada escritor de fase 2 añade `syncRevision`, solo servidor. El token combina revisión y contenido normalizado, y sesiones/tareas incorporan dependencias. El cliente conserva el token solo si la huella del contenido coincide con su vista. No cambia ninguna firma congelada existente.

4. Los escritores futuros de otras fases que cambien sesiones, líneas, tareas o carta deben emitir revisiones con este mismo servicio. La huella del contenido protege frente a cambios relevantes de escritores antiguos, pero no convierte una escritura externa que restaura exactamente el mismo documento en una revisión nueva.
5. Reglas e índices: datos en `reglas.md`. Las reglas actuales ya deniegan SDK sobre protocolo e idempotencia; no hace falta ampliar lecturas. No se solicitan índices nuevos.

## Límites visibles

La pantalla preparada permite seguir guardando durante el corte. Al recargar sin internet, el worker abre una carcasa pública que consulta el número de pendientes del espacio local autorizado; no guarda HTML autenticado, respuestas Auth, API, QR, facturas ni exportaciones en Cache Storage. Para continuar editando durante el corte se conserva abierta la pantalla preparada. La carcasa conserva la cola y vuelve al panel al recuperar internet; no promete arrancar un servicio completo sin visita y sesión previas. No hay sincronización entre tablets sin servidor, envío a cocina durante el corte ni servidor local. La alternativa sigue siendo voz y papel.

Tarjeta, Stripe, facturas fiscales, devoluciones, señales, cierre y arqueos requieren conexión. El recuento local de efectivo no confirma un cobro. Al salir se conserva la cola bloqueada; no se borra una intención incierta. Borrar datos del navegador, navegación privada, falta de espacio o pérdida del dispositivo pueden perder pendientes. No se envía nada al cerrar el navegador. No se ha usado Stripe real ni configurado Billing: sin claves no se cobra nada. No se modifican planes ni precios comerciales provisionales.

## Prueba local

Puertos de la fila 3. Configuración local `firebase.agente3.json`, excluida de git. Como Firestore necesita un puerto websocket adicional, UI está deshabilitada y su puerto 4013 sirve al websocket. No se usa ningún puerto del coordinador.

```bash
pnpm install
pnpm funciones:build
pnpm --filter functions exec tsup src/fase6-sync/emulator-entry.ts --out-dir ../.firebase/fase6-sync/lib
npx firebase emulators:start --project demo-llenamos --config firebase.agente3.json
```

La entrada local reexporta lo existente, las funciones de caja ya presentes y las cuatro de esta fila. `.firebase/fase6-sync/package.json` copia el de Functions con `main: lib/emulator-entry.js`, y enlaza `node_modules` de Functions. No forma parte del despliegue. Variables de web según `.env.example`, con los cuatro puertos de esta fila.

```bash
export GCLOUD_PROJECT=demo-llenamos
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8098
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9104
pnpm seed
pnpm seed:servicio
pnpm exec tsx scripts/seed-fase3.ts
pnpm build
pnpm --filter web exec next start --port 3013
pnpm exec tsx scripts/sync-browser.ts
```

El script usa las cuentas de demo, Chromium instalado y `BrowserContext.setOffline(true)`. Crea mesas de prueba identificadas con `sync-` dentro de la demo; cada ejecución usa destinos nuevos. No utiliza datos externos. El registro manual del worker es únicamente parte de la comprobación de integración.

```bash
TEST_FIREBASE_EMULATORS=1 pnpm --filter functions exec vitest run src/fase6-sync src/fase2 --hookTimeout=60000
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Para la integración completa se ejecutan primero los dos archivos de integración base con disparadores activos y luego el resto de Functions en otro bloque, como indica la entrega existente de caja. Durante la carga masiva de fixtures se pueden deshabilitar los disparadores con `PUT http://127.0.0.1:4413/functions/disableBackgroundTriggers`; evita esperas del emulador por las proyecciones mientras se aprovisionan documentos parciales. Las pruebas de servicio invocan la lógica real y usan transacciones del emulador, sin simular Firestore.

Después de parar los procesos propios:

```bash
npx firebase emulators:exec --project demo-llenamos --config firebase.agente3.json --only firestore,storage "vitest run --root tests/rules"
```

Capturas y resultados de navegador en `docs/diseno/capturas/sin-conexion/`. Mensaje de commit propuesto: `feat: guardar y sincronizar el servicio sin conexión con recibos idempotentes`.
