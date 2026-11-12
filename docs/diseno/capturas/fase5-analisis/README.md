# Análisis, resumen y previsión

Trabajo de la fila 4 en `fase5/analisis-web`. Solo cambia la web de análisis y esta carpeta de evidencias. No cambia core, firmas, navegación, servidor, reglas ni dependencias.

## Qué se entrega

- `/panel/analisis`: fechas de hasta 366 días, periodo anterior de igual duración, local o todos los locales autorizados, métricas, evolución diaria, horas punta de 15, 30 o 60 minutos, platos más y menos vendidos y platos de la carta activa sin ventas.
- Comparaciones sin base expresadas como «Sin base anterior»; denominadores ausentes como «Sin datos». El margen solo se monta con `costes.ver` e `inventory`, con cobertura y merma histórica. Sin `pos` se avisa de que faltan las ventas.
- Cinco exportaciones CSV del servidor, hasta 92 días. Origen solo se ofrece con `marketing`. No se calculan ni se reconstruyen los CSV reales en el navegador.
- Previsión de 1 a 14 días para un local, con tramos de 15 minutos, reservas, proyección final, confianza, variación, número y fechas de las semanas que la respaldan. Gráficas SVG propias con cifras accesibles en tablas o listas.
- Resumen por fecha, búsqueda del último disponible en los últimos 92 días y editor de destinatarios, hora, canales, día resumido y umbrales. La búsqueda se detiene ante un fallo de backend, permiso o contrato; solo salta días que el endpoint identifica como inexistentes. Para historia anterior se consulta la fecha directamente. `dailySummaries` nunca se lee desde el SDK cliente.
- Reglas con los siete eventos de core, condiciones de todas o alguna, grupos hasta dos niveles, recomendación, locales y enfriamiento. Crear, editar, apagar y borrar con revisión; simulación de hasta 92 días. Bandeja con evidencia, caducidad, nota y aceptación o descarte. Decidir no ejecuta ninguna acción; se ofrecen enlaces para hacerla a mano.

Las nueve callables se invocan desde `lib/analisis/api.ts`, validando entrada y salida con `CALLABLE_SCHEMAS`. El acceso de las operaciones usa `FASE5_ACCESS`. Las lecturas de ajustes, reglas y recomendaciones validan los esquemas de core y separan los campos de auditoría de los esquemas estrictos de entrada. No hay escrituras directas a Firestore. Los reintentos de mutaciones inciertas conservan `requestId`; no se añade a consultas ni exportaciones. Una respuesta antigua nunca sustituye los datos de otro filtro o restaurante.

## Estado del backend y fixtures

Esta rama parte del contrato; el backend de fase 5 se construye en paralelo en `fase5/backend` y aún no está registrado aquí. La consulta real muestra explícitamente que falta, sin cifras inventadas ni confirmaciones de guardado. `sin-backend.png` documenta ese estado contra Functions 5015.

En local se puede abrir `?ejemplo=1`, exclusivamente con `NEXT_PUBLIC_USE_EMULATORS=1`. Un aviso permanente identifica las fixtures como cifras inventadas y ofrece volver a datos reales. No es una alternativa automática a un error. Guardar, exportar, simular en el servidor, borrar y resolver recomendaciones están desactivados. Las fixtures de `lib/analisis/fixtures.ts` reutilizan `deriveMetrics`, `comparePeriods`, `compareLocations`, `dishSales`, `peakSlots`, `forecastDay` y `renderDailySummary`; no implementan otro motor.

Las capturas de las cuatro vistas usan estas fixtures dentro de una sesión real de Firebase. No prueban operaciones de backend terminadas. El listado de miembros del editor procede del emulador. Las capturas de acceso y de backend ausente no usan respuestas interceptadas ni dobles HTTP.

## Reproducir

Desde este worktree, con las dependencias instaladas:

```bash
export PNPM_HOME=/tmp/llenamos-agent4-pnpm
pnpm funciones:build
XDG_CONFIG_HOME=/tmp/llenamos-agent4-config npx firebase emulators:start --project demo-llenamos --config firebase.agente4.json
```

`firebase.agente4.json` es una copia local de `firebase.json`, excluida de git. Puertos configurados: Auth 9105, Firestore 8099, Functions 5015, Storage 9215, UI 4014, Hub 4414, Logging 4514, Eventarc 9314 y Tasks 9514. La configuración aislada de Firebase evita usar la sesión de nube del equipo. El `PNPM_HOME` temporal permite utilizar la versión fijada de pnpm sin escribir fuera de los directorios autorizados.

En otra terminal:

```bash
export PNPM_HOME=/tmp/llenamos-agent4-pnpm
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8099
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9105
export GCLOUD_PROJECT=demo-llenamos
pnpm seed
pnpm seed:servicio
```

El seed común deja el plan `sala`. Para estas pruebas se activó `completo` solo en el restaurante del emulador, conservando el contrato de módulos:

```bash
pnpm exec tsx -e 'import {initializeApp} from "firebase-admin/app"; import {getFirestore} from "firebase-admin/firestore"; import {activeModulesFor} from "./packages/core/src/index"; initializeApp({projectId:"demo-llenamos"}); const db=getFirestore(); db.doc("restaurants/demo-lumbre").update({plan:"completo",activeModules:activeModulesFor("completo")}).then(()=>db.terminate())'
```

`apps/web/.env.local` usa `demo-llenamos`, `NEXT_PUBLIC_USE_EMULATORS=1`, los cuatro puertos anteriores y `NEXT_PUBLIC_SITE_URL=http://localhost:3014`.

```bash
pnpm --filter web exec next dev --port 3014
```

Entrar desde `http://localhost:3014/entrar` con `propietario@lumbre.test` o `encargada@lumbre.test`, contraseña `Llenamos2026!`. Abrir directamente `/panel/analisis`, ya que la navegación la integra el coordinador. Para revisar el diseño: `/panel/analisis?ejemplo=1`; las otras vistas usan `&vista=prevision`, `&vista=resumen` y `&vista=reglas`. En la última, «Crear regla» abre el editor. Camarero, cocina y barra reciben la pantalla de acceso denegado incluso con `ejemplo=1`.

Al terminar se paran únicamente los procesos iniciados para esta fila. No se han utilizado servicios reales ni envíos externos.

Incidencia de limpieza de esta ejecución: las sesiones de arranque terminaron con SIGINT, pero quedaron procesos hijos escuchando en los puertos de la fila 4. La herramienta ejecuta cada orden en un espacio de PID distinto y, después de cerrar la sesión, ya no permite señalarlos. Queda pendiente detenerlos desde la terminal del coordinador, identificando primero el proceso de `firebase.agente4.json` y el Next de este worktree y haciendo `kill` únicamente de sus PID. No se han intentado matar procesos de otras filas. No se debe interpretar el cierre de la sesión como confirmación de que esos puertos están libres.

## Capturas

Chromium local mediante Playwright, `deviceScaleFactor: 2`, página completa. El ancho de cada PNG es exactamente el doble del viewport. En tableta y móvil se activó entrada táctil. Sin desbordamiento horizontal del documento en ninguna de las doce vistas.

| Vista | Escritorio 1440 × 900 | Tableta 1180 × 820 | Móvil 390 × 844 |
|---|---|---|---|
| Ventas y sala | [Captura](escritorio-ventas.png) | [Captura](tableta-ventas.png) | [Captura](movil-ventas.png) |
| Previsión, un día seleccionado | [Captura](escritorio-prevision.png) | [Captura](tableta-prevision.png) | [Captura](movil-prevision.png) |
| Resumen y ajustes | [Captura](escritorio-resumen.png) | [Captura](tableta-resumen.png) | [Captura](movil-resumen.png) |
| Recomendaciones y editor | [Captura](escritorio-reglas.png) | [Captura](tableta-reglas.png) | [Captura](movil-reglas.png) |

Estados reales adicionales: [backend ausente](sin-backend.png), [camarero sin acceso](acceso-camarero.png), [cocina sin acceso](acceso-cocina.png) y [barra sin acceso](acceso-barra.png).

## Comprobaciones

- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` completos en verde. Las pruebas generales de integración que requieren activación explícita permanecen omitidas por el repositorio: no se presentan como ejecutadas. No se han tocado servidor ni reglas.
- 17 pruebas específicas de análisis: roles y módulos, validación de entradas y respuestas, backend ausente, comparación sin base, denominadores vacíos, margen oculto, semanas y confianza de previsión, búsqueda del último resumen, requestId conservado, exportación sin requestId y descarte de respuestas de otro local.
- Navegador con Auth, Firestore y Functions de la fila 4, `pnpm seed` y `pnpm seed:servicio`: acceso permitido a propietaria y encargada; denegado a camarero, cocina y barra sin consultar métricas; ausencia de backend explícita; guardado y decisión desactivados en fixtures; editor con grupos de condiciones; doce vistas sin desbordamiento horizontal.
- Build sin errores. La web de venta conserva su aviso previo de tamaño del paquete, fuera de este encargo.

## Datos para integrar el menú

No se ha modificado `lib/panel/nav.ts` ni la barra lateral. Entrada propuesta:

```json
{
  "section": "analisis",
  "href": "/panel/analisis",
  "label": "Análisis",
  "group": "servicio",
  "permission": "analisis.ver",
  "module": "analytics",
  "icon": "ChartBarIcon de @phosphor-icons/react"
}
```

La previsión requiere además `reservations`; el margen, `costes.ver` e `inventory`; la exportación de origen, `marketing`. Resumen y reglas usan `analisis.configurar` según `FASE5_ACCESS`.

## Pendiente de integración

Registrar el backend y sus procesos, reglas e índices desde la fila 1; conectar la entrada de menú; ejecutar el recorrido real de cifras, exportación, guardado, simulación y resolución con ese backend. Las firmas y las colecciones son las del contrato congelado. No se ha añadido ninguna dependencia ni se ha cambiado el contrato.

Mensaje de commit propuesto: `Añade el panel de análisis, resumen diario y previsión con recomendaciones`.

Los cambios quedan sin commit ni push para revisión del coordinador.
