> Integración actual: la entrada común, menú, reglas e índices ya están conectados. Usa el build normal y el recorrido de [fase 3](../../docs/diseno/capturas/fase3/README.md). Los pasos de exportación siguientes documentan la entrega original.

# Impresión local de Llenamos

El restaurante instala este puente en un ordenador que permanezca encendido y tenga acceso a las impresoras por TCP 9100. Node 22 o posterior, sin paquetes adicionales. No abre un servidor HTTP local. No necesita una cuenta de Firebase ni las credenciales del personal.

Perfil soportado: ESC/POS, CP858, 203 ppp, papel de 80 mm y 48 columnas o de 58 mm y 32 columnas. Hay que comprobar el modelo, el ancho imprimible, el corte, CP858 y el cable del cajón con el proveedor. No se ha utilizado hardware real. Un cierre TCP limpio confirma el envío de bytes, no verifica papel, tinta ni salida física. El panel muestra «Envío confirmado por el puente» solamente tras esa confirmación.

## Instalación

1. Copia esta carpeta al ordenador del local. Ejecuta `node --version` y comprueba Node 22 o posterior.
2. Un propietario o encargado abre `/panel/impresoras`, selecciona el local y crea una credencial para un puente, por ejemplo `mostrador`. La credencial solo autoriza ese restaurante y ese local. Guarda el archivo fuera de una carpeta pública o compartida.
3. Copia `config.example.json` a `config.json`. En Linux/macOS, ejecuta `chmod 600 config.json`. En Windows limita los permisos del archivo y la carpeta a la cuenta que ejecuta el puente. Copia `restaurantId`, `locationId`, `bridgeId` y `token` desde el panel. No pongas credenciales en argumentos de terminal ni capturas.
4. Da de alta las impresoras en el panel. Copia sus referencias en el mapa `printers` del archivo. La dirección IP o nombre de red y el puerto 9100 se guardan **solo en ese archivo local**. Asigna las estaciones y, como máximo, una impresora activa a la caja. El perfil 58 mm usa 32 columnas; el de 80 mm usa 48.
5. En desarrollo usa `http://127.0.0.1:5012/demo-llenamos/europe-west1` como `functionsUrl`. El puente solo permite HTTP con loopback y esta ruta de emuladores. Un entorno productivo necesitaría el origen HTTPS de las funciones integradas; este trabajo no despliega nada.
6. Arranca `node bridge.mjs ./config.json`. Para un solo ciclo, `node bridge.mjs ./config.json --once`. Solicita «Imprimir prueba» en el panel. La prueba dice que no es una venta y no abre el cajón.
7. Configura el arranque al iniciar el ordenador con una cuenta dedicada y directorio de trabajo fijo. Por ejemplo, una tarea del programador de Windows o un servicio del sistema con `ExecStart=/usr/bin/node /ruta/print-bridge/bridge.mjs /ruta/privada/config.json`. Mantén el diario y la configuración en disco local persistente y con permisos privados.

Detén el proceso con Ctrl C o SIGTERM. Termina el envío activo y guarda su resultado antes de salir. No ejecutes dos instancias con el mismo diario. El archivo `bridge.lock` evita esa concurrencia. Después de un apagado brusco comprueba que no queda ningún proceso del puente y retira **solo** `bridge.lock`; conserva los archivos de trabajos.

## Fallos y credenciales

El diario se sincroniza a disco **antes** de enviar bytes. Al reiniciar, un envío interrumpido queda incierto. Si la respuesta del servidor se pierde, se reintenta la confirmación, nunca el envío. No borres el diario para forzar una impresión. Un lease dura 60 segundos, un envío tiene un plazo de 4 segundos y las llamadas HTTP de 10 segundos. Se reclama un trabajo cada vez. El hash SHA-256 y el límite de tamaño se verifican antes de abrir la conexión.

Un fallo antes de escribir permite reintento explícito desde Caja. Un envío incierto o un lease caducado no vuelve a enviarse. Revisa el papel y pide una **copia** desde Caja si hace falta. Una copia lleva «Copia», no consume número fiscal ni abre el cajón. La apertura del cajón es una petición independiente, deduplicada, que exige encargado y un cobro en efectivo confirmado.

Para renovar una credencial: detén el puente, resuelve sus trabajos activos, pulsa «Crear o renovar credencial», reemplaza `token` en el archivo protegido y arráncalo otra vez. La anterior deja de funcionar inmediatamente. Una respuesta perdida de vinculación puede recuperarse con el mismo `requestId` durante diez minutos; los intentos que contienen tokens deben expurgarse con TTL (`printIntents.expiresAt`). El puente no registra tokens, cuerpos de error remotos ni los bytes. No compartas el diario: conserva los secretos de lease necesarios para recuperar las confirmaciones. Si una rotación invalida una confirmación antigua, revisa el trabajo incierto antes de archivar su archivo del diario. El servidor nunca lo reenvía automáticamente.

El texto soporta los acentos castellanos de CP858. Los demás caracteres se sustituyen por `?`. No uses otros alfabetos sin revisar el repertorio de la impresora. Los controles introducidos en textos no se convierten en órdenes. La prueba incluye acentos y euro para comprobarlo.

## Comprobación sin impresora

```bash
node --test tools/print-bridge/bridge.test.mjs
```

El servidor TCP falso escucha en loopback 9100, guarda un `.bin` temporal y compara todos los bytes con el ESC/POS esperado. Las pruebas cubren cierre limpio, fallo antes de conectar, timeout después de escribir, hash manipulado, lease caducado, reinicio y pérdida de confirmación sin duplicar bytes. No afirma impresión física.

El QR fiscal se codifica realmente con corrección M en el servidor, versión 11, modo byte y máscara 0, hasta 251 bytes UTF8. El raster es de unos 30,5 mm más blanco de seguridad; cabe en 58 y 80 mm. Rechaza enlaces demasiado largos en vez de quitar el QR. El código adapta el generador propio ya usado en carta. Los vectores se han contrastado con [Project Nayuki](https://www.nayuki.io/page/qr-code-generator-library); el generador independiente solo se utilizó en `/tmp`, no es dependencia de ejecución. Las facturas del proveedor local llevan **«no válido para Hacienda»**. No se contacta Hacienda ni Stripe.

## Integración que debe aplicar el coordinador

No se han editado `functions/src/index.ts`, menús, scripts comunes ni `firebase/**` para respetar el reparto. Las funciones y las reglas de caja siguen pendientes de la otra rama. Los siguientes cambios son datos para la integración:

```ts
// functions/src/index.ts
export {
  guardarImpresora, vincularPuente, solicitarImpresion,
  reclamarImpresiones, confirmarImpresion,
  peticionImpresion, comandaMarchada, impresoraActualizada,
} from './fase3-print'
```

Para arrancar **solo esta fila en local**, sin cambiar la entrada compartida:

```bash
pnpm --filter functions exec tsup --config src/fase3-print/local.config.ts
npx firebase emulators:start --project demo-llenamos --config firebase.agente1.json
```

Ese empaquetado local incluye la entrada existente y la nueva. El build normal sigue dependiendo de las exportaciones del coordinador. `pnpm build` reemplaza ese empaquetado local, así que se debe repetir antes de arrancar los emuladores para la pantalla. En esta caja de herramientas, `npm_config_manage_package_manager_versions=false` permite usar el pnpm instalado sin escribir su gestor fuera del worktree. `XDG_CONFIG_HOME=/tmp/impresion-config` evita que Firebase intente guardar credenciales de una sesión ajena; solo se usan emuladores.

Entrada de menú propuesta, en el grupo de configuración:

```json
{ "href": "/panel/impresoras", "label": "Impresoras", "permission": "impresion.gestionar", "module": "pos", "icon": "printer" }
```

Reglas propuestas, dentro del ámbito `/databases/{database}/documents`, reutilizando las funciones existentes `local`, `module`, `manages`, `member`:

```text
match /restaurants/{rid}/locations/{lid}/printers/{id} {
  allow read: if local(rid,lid) && module(rid,'pos') && manages(rid);
}
match /restaurants/{rid}/locations/{lid}/printStatuses/{id} {
  allow read: if local(rid,lid) && module(rid,'pos')
    && member(rid).role in ['owner','manager','waiter'];
}
```

Sin ninguna escritura cliente. `printRequests`, `printJobs`, `printBridges`, `printLeases`, `printIntents` y `printCopies` siguen sin acceso de SDK cliente, incluso para owner. La actividad nunca contiene tokens ni bytes. Los metadatos de servidor incluyen `updatedBy` con el autor autenticado o nulo para el sistema.

Índices compuestos de `printJobs`, ámbito COLLECTION:

```json
[
  { "collectionGroup": "printJobs", "queryScope": "COLLECTION", "fields": [
    { "fieldPath": "bridgeId", "order": "ASCENDING" },
    { "fieldPath": "status", "order": "ASCENDING" }
  ] },
  { "collectionGroup": "printJobs", "queryScope": "COLLECTION", "fields": [
    { "fieldPath": "bridgeId", "order": "ASCENDING" },
    { "fieldPath": "status", "order": "ASCENDING" },
    { "fieldPath": "leaseUntil", "order": "ASCENDING" }
  ] }
]
```

Los filtros por `printRequests.status`, `orderLines.orderId` y la cola visible ordenada por `printStatuses.updatedAt` usan índices simples. Para ahorrar almacenamiento y no indexar secretos se recomienda eximir de índices `printJobs.payloadBase64`, `printJobs.document`, `printBridges.tokenHash`, `printLeases.leaseTokenHash` y `printIntents.result`, y activar TTL en `printIntents.expiresAt`. El TTL requiere configuración del coordinador, no se aplica en la nube en este trabajo.

Caja crea `PrintRequest` como en core, con id determinista; `printerId:null` enruta a la caja activa. Cada trabajo guarda bytes, hash, documento y `bridgeId` congelados; solo cambia su estado de envío. Las comandas se deduplican por pedido, estación, pase, destino y `firedAt`. El proceso local de reconciliación permite recuperar peticiones `queued` o `not_configured` tras una interrupción.

Facturas: se leen `invoices/{id}.recordId` y el artefacto original de `restaurants/{rid}/fiscalRecords/{recordId}`, verificando `locationId` e `invoiceId`. Acepta los campos del artefacto en la raíz o dentro de `artifact`. Nunca reconstruye un QR desde datos cambiados ni emite una factura para imprimir.

Cambio mínimo y aditivo en core: entrada `solicitarImpresion.kind` admite `test`; el trabajo de prueba sigue siendo `prebill`. La salida de `reclamarImpresiones.jobs` añade `printerId` y `payloadHash`. Véase `ARQUITECTURA.md`. No se han cambiado cálculos ni el libro de caja.

Consultas adicionales del servicio: índice compuesto `printJobs` por `printerId ASC, status ASC` (protección de cambios de perfil mientras hay cola), y por `printerId ASC, sourceId ASC, kind ASC, copy ASC` (recuperar las comandas originales para una copia). Una copia manual de comanda de un pedido recupera todos sus documentos originales congelados de esa impresora, hasta 50 marchas; nunca reconstruye nombres o notas desde líneas modificadas. Si no se puede recuperar el conjunto completo se rechaza. Cambiar puente o papel con trabajos pendientes también se rechaza.

Reconciliación local de solicitudes, sin confirmar impresión:

```bash
GCLOUD_PROJECT=demo-llenamos FIRESTORE_EMULATOR_HOST=127.0.0.1:8096 pnpm exec tsx scripts/impresion-reconciliar.ts demo-lumbre centro
```

Recorrido HTTP completo con TCP falso, después de seed y del empaquetado local:

```bash
GCLOUD_PROJECT=demo-llenamos FIRESTORE_EMULATOR_HOST=127.0.0.1:8096 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9102 pnpm exec tsx scripts/impresion-e2e.ts
```

Este script está restringido a los emuladores de la fila 1. Habilita `pos` solo en la demo, vincula un puente de prueba, desactiva sus impresoras anteriores para evitar ambigüedad y crea datos de factura y cobro **expresamente de prueba** para comprobar el transporte. No representa el recorrido de facturación del backend de caja, todavía en otra rama. Compara los `.bin` capturados con el ESC/POS esperado de prueba en ambos anchos, factura, copia y cajón, verifica la proyección final y comprueba que un trabajo confirmado no se reenvía. El servidor falso y sus archivos se cierran y borran al terminar.

## Entrega y comprobaciones

Trabajo sin commit ni push. La rama estaba limpia y coincidía con `origin/main`; `git log origin/main..HEAD --stat` no mostraba el «Trabajo en curso» mencionado en el encargo. Se implementó esta fila desde el contrato disponible.

Comprobación final en este worktree:

| Comprobación | Resultado |
|---|---|
| `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | Verde. Core 395, Functions 76 y web 475 pruebas activas en la ejecución normal |
| Integración de Functions con emuladores recién arrancados, `TEST_FIREBASE_EMULATORS=1 GCLOUD_PROJECT=demo-llenamos` | 138 pruebas correctas, 11 omitidas por sus condiciones de ejecución |
| Integración específica `functions/src/fase3-print/` | 23 pruebas correctas: backend y permisos, reglas propuestas, QR y perfiles |
| `npx firebase emulators:exec --project demo-llenamos --config firebase.agente1.json --only firestore,storage "vitest run --root tests/rules"` | 78 pruebas correctas |
| `node --test tools/print-bridge/bridge.test.mjs` | 7 pruebas correctas |
| `scripts/impresion-e2e.ts` | HTTP real, cola, diario, TCP falso, comparación exacta y confirmación del puente |
| Navegador con emuladores y seed reales | Alta, edición, asignación a estaciones y caja, rotación, prueba, confirmación e incierto; capturas 2x |
| Escaneo del raster fiscal | El lector independiente recupera exactamente la URL en los dos anchos |

No se han añadido dependencias ni cambiado las reglas del repositorio. La configuración de la fila y `.env.local` están excluidas de Git. Los servicios y servidores TCP de prueba se han detenido. Los cambios de contrato son las dos ampliaciones de API descritas arriba, documentadas también en `ARQUITECTURA.md`.

Pendiente del coordinador: exportaciones, entrada de menú, reglas e índices de este documento, conexión con el backend de caja de la otra rama y revisión del proveedor/modelo de impresora física. El proveedor fiscal local sigue siendo **no válido para Hacienda**. No se ha contactado Stripe ni Hacienda, ni se ha desplegado nada.

Mensaje de commit propuesto: `Añade impresión ESC/POS con cola durable, puente local seguro y panel de impresoras`.

En la prueba integrada de la fila 5, solo con URL de Functions HTTP local de `demo-llenamos`, se permite un servidor TCP falso en `127.0.0.2:9515`. Tasks sigue en `127.0.0.1:9515`. Fuera de ese entorno el mapa sigue exigiendo TCP 9100. Esta excepción no habilita puertos ni comandos desde la web.
