# Fase 5 · Campañas y origen

Entrega del agente 3 en `fase5/campanas-web`. Todo se ha probado en el worktree y en el proyecto local `demo-llenamos`. No hay dependencias nuevas, cambios de core, firmas, permisos, reglas ni contrato. No se han hecho commits ni envíos reales.

## Pantallas

- `/panel/campanas`: borradores, editor, simulación con mensaje final, audiencia, exclusiones, ventana de envío, programación con confirmación solo para el propietario, cancelación con motivo e informe de mensajes, bajas, reservas, comensales y ventas.
- `/panel/campanas/segmentos`: editor de todas las condiciones de `SegmentRule`, vista previa por canal y motivos de exclusión sin contactos. Guardado y borrado con revisión.
- `/panel/campanas/ajustes`: firma, frecuencia entre canales y ventana local de envío.
- `/panel/campanas/origen`: periodo y locales accesibles; agrupación por canal, campaña o anuncio. Se distinguen las reservas antiguas sin origen del canal directo.
- `/baja/[slug]?t=...`: página pública con controles de 48 px. No hace una mutación al abrir el enlace. Tras confirmar, el texto es idéntico para tokens válidos e inexistentes. Si el backend falla, no afirma que se haya registrado la baja.

Se reutilizan `PageHeading`, `SummaryStrip`, `SummaryList`, `Notice`, `Desplegable`, `Sheet`, campos, botones y casillas existentes, con iconos Phosphor. Las lecturas usan los esquemas de core; las once callables de marketing usan `CALLABLE_SCHEMAS` en entrada y salida, y las pantallas consultan `FASE5_ACCESS`. No se escribe desde el SDK cliente. Los reintentos de una misma intención conservan `requestId` cuando la respuesta es incierta. La simulación se invalida si cambia la revisión; una confirmación abierta tampoco permite programar una revisión distinta.

`sent` significa que terminó la preparación de la campaña: el informe distingue las entregas reales de `captured`, `notConfigured`, fallidos y cancelados. WhatsApp dice expresamente que no saldrá sin cuenta verificada y plantilla aprobada.

## Datos reales y fixtures

Las callables y reglas de la fase 5 todavía no están integradas en esta rama. La navegación real enseña que faltan los datos o el backend y no cambia a datos inventados cuando falla una lectura. La baja se ha recorrido contra Functions 5014: el backend ausente produce un aviso de baja sin confirmar.

`/panel/campanas/ejemplos` está disponible solo con `next dev`, detrás de los mismos permisos y módulo. En producción la página ejecuta `notFound()` antes de montar las fixtures. No se ha podido verificar por HTTP el estado de esa respuesta, porque el proceso de desarrollo quedó reteniendo 3013 al cerrar su sesión. Usa `apps/web/src/lib/campanas/fixtures.ts`, con entradas y salidas verificadas por los esquemas. El aviso de fixture permanece visible; guardar, lanzar y cancelar están desactivados. No hay llamadas al backend desde las vistas de ejemplo. Los campos de consentimiento de la fixture son interactivos, pero no se guardan.

La campaña en borrador sirve para la simulación. Otra campaña, con preparación terminada, sirve para el informe. Ninguna cifra de las fixtures describe la actividad real de Taberna Lumbre.

## Capturas

Capturadas el 10 de noviembre de 2026 con Chromium y Playwright, `deviceScaleFactor: 2`, sin desbordamiento horizontal. Los controles de desarrollo de Next se ocultan únicamente al capturar. Se desactivan las animaciones al tomar las imágenes.

| Sufijo | Ventana CSS | Escala |
|---|---|---|
| `escritorio` | 1440 × 900 | 2x |
| `tableta` | 1180 × 820 | 2x |
| `movil` | 390 × 844, táctil | 2x |

Cada prefijo tiene los tres tamaños:

| Prefijo | Qué muestra |
|---|---|
| `campanas` | Lista y resumen de fixtures |
| `simulacion` | Detalle del borrador, ventana y audiencia de fixture |
| `mensaje-simulacion` | Mensaje final de muestra, baja y primer envío |
| `informe` | Resultados de una campaña de fixture con preparación terminada |
| `whatsapp` | Aviso de cuenta sin verificar y plantilla pendiente |
| `segmento` | Editor de condiciones de la fixture |
| `origen` | Informe agrupado por canal, cifras de fixture |
| `ajustes` | Ajustes iniciales de fixture |
| `permiso` | Casillas opcionales desmarcadas y versión de política de fixture |
| `baja` | Página pública antes de solicitar la baja, sin fixture de resultado |

`backend-pendiente-escritorio.png` es la lectura real rechazada por las reglas actuales del emulador. `baja-backend-pendiente-movil.png` es el fallo real de la callable ausente, sin simular éxito. Las capturas de panel con contenido usan fixtures, no una implementación local falsa del backend.

## Repetir la prueba local

Crear `firebase.agente3.json` copiando `firebase.json`, con Auth 9104, Firestore 8098, Functions 5014, Storage 9214, UI 4013, Hub 4413, Logging 4513, Eventarc 9313 y Tasks 9513. El archivo está excluido de git. `apps/web/.env.local` se copia de `.env.example` con los cuatro puertos públicos de esa fila, `NEXT_PUBLIC_USE_EMULATORS=1` y `NEXT_PUBLIC_SITE_URL=http://localhost:3013`.

En esta caja, el gestor de paquetes y Firebase necesitan directorios temporales de configuración para no intentar escribir fuera de la caja de seguridad:

```bash
export PNPM_HOME=/tmp/f5-campanas-pnpm
export XDG_CACHE_HOME=/tmp/f5-campanas-cache
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8098
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9104
export GCLOUD_PROJECT=demo-llenamos
pnpm funciones:build
XDG_CONFIG_HOME=/tmp/f5-campanas-config npx firebase emulators:start --project demo-llenamos --config firebase.agente3.json
```

En otro terminal del mismo worktree, con las mismas variables:

```bash
pnpm seed
pnpm seed:servicio
pnpm --filter web exec next dev --port 3013
```

El seed usa el plan `sala`, que no trae marketing. Solo en el emulador, se activó `marketing` en `restaurants/demo-lumbre` mediante Admin SDK, conservando el resto de módulos y añadiendo `moduleOverrides.marketing: true`. No se cambió el catálogo ni el seed compartido. Para repetirlo, con `FIRESTORE_EMULATOR_HOST` y `GCLOUD_PROJECT` anteriores:

```bash
node <<'JS'
const { initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')
initializeApp({ projectId: 'demo-llenamos' })
;(async () => {
  const ref = getFirestore().doc('restaurants/demo-lumbre')
  const data = (await ref.get()).data()
  await ref.update({
    moduleOverrides: { ...data.moduleOverrides, marketing: true },
    activeModules: [...new Set([...data.activeModules, 'marketing'])],
  })
})()
JS
```

Entrar por `/entrar` con `propietario@lumbre.test`, `encargada@lumbre.test` o `camarero@lumbre.test`, contraseña `Llenamos2026!`. Se ha comprobado con esas cuentas en Chromium: propietario ve Lanzar, encargado no lo ve y camarero no monta las campañas. En fixtures, el botón del propietario está desactivado para impedir mutaciones.

Playwright se obtiene de `/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright`, con ejecutable `/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`. El recorrido de capturas usa las pestañas de ejemplos y la baja pública; rechaza solicitudes a dominios distintos de localhost. Si se reutiliza la sesión con `storageState`, hay que incluir `indexedDB: true`, porque Firebase Auth guarda allí su sesión.

## Montar las piezas en la fase 1

Los archivos públicos compartidos no se han tocado. El coordinador monta estas piezas en el componente cliente que contiene el formulario de `/r/[slug]` y en el formulario de `/widget/[slug]`, después de los datos de contacto y antes de confirmar la reserva.

```tsx
import { useAtribucion } from '@/lib/origen/useAtribucion'
import { CasillasPermiso, permisoInicial } from '@/components/origen/CasillasPermiso'

// policyVersion y policyUrl deben venir de la política vigente del restaurante.
// Usar una key con restaurante y policyVersion al cambiar de política o formulario.
const attribution = useAtribucion({ widget: esWidget })
const [marketingOptIn, setMarketingOptIn] = useState(() => permisoInicial(policyVersion))

<CasillasPermiso
  policyVersion={policyVersion}
  policyUrl={policyUrl}
  value={marketingOptIn}
  onChange={setMarketingOptIn}
  disabled={guardando}
/>

// Esperar a attribution !== null antes de enviar. No bloquear por casillas sin marcar.
// Añadir a la entrada existente de crearReservaPublica:
{ ...entradaReserva, attribution, marketingOptIn }
```

`useAtribucion()` sirve para la web; `useAtribucion({ widget: true })` para el widget. Devuelve `ReservationAttributionInput | null`, llama a `attributionFromUrl`, conserva solo tipos de clic y usa el dominio del referente. No usa cookies, almacenamiento ni seguimiento entre visitas. Un parámetro excesivo no rompe el formulario; se captura la ruta y los dominios sin los parámetros inválidos.

Para el widget sin referente, el gancho escucha un mensaje del padre. Comprueba `event.source === window.parent`, el origen HTTP o HTTPS y que el dominio declarado coincida con ese origen. Acepta este mensaje:

```js
{
  type: 'llenamos:attribution',
  embedHost: window.location.hostname // del padre
}
```

Al instalarse el gancho, envía al padre `{ type: 'llenamos:request-attribution' }`, sin datos de la visita. El coordinador debe responder desde `public/widget.js`, comprobando que la petición viene de `iframe.contentWindow` y del origen de Llenamos, con `iframe.contentWindow.postMessage(mensaje, origenDeLlenamos)`. Esto evita perder un mensaje enviado antes de que React escuche. El padre también puede responder al evento `load`. El hook permite `embedHost` opcional si coincide con el dominio del referente; el protocolo de mensajes cubre la ausencia de referente.

Las casillas reciben exactamente `policyVersion`, `policyUrl`, `value`, `onChange` y `disabled?`. `permisoInicial(version)` pone ambos canales en `false`. Un cambio de versión desmarca las casillas y notifica el reinicio al formulario. Una casilla sin marcar no retira permisos anteriores. El coordinador debe obtener la versión real y escribir los consentimientos y el origen en la misma transacción que la reserva, como manda el contrato.

## Menú para el coordinador

Datos propuestos, sin editar `lib/panel/nav.ts` ni la barra lateral:

```ts
{
  section: 'campanas',
  href: '/panel/campanas',
  label: 'Campañas',
  group: 'restaurante',
  permission: 'campanas.gestionar',
  module: 'marketing',
}
// Icono de @phosphor-icons/react: MegaphoneIcon.
```

Las pestañas internas son Campañas, Segmentos, Origen y Ajustes. El informe de origen usa `FASE5_ACCESS.informeOrigen`: `analisis.ver` con `marketing`, sin exigir `analytics`.

## Comprobaciones y pendiente

Se ha ejecutado la cadena `pnpm lint && pnpm typecheck && pnpm test && pnpm build` en verde: core 609 pruebas, web 603 y functions 117. Las 24 pruebas específicas de esta entrega pasan. Pruebas específicas: validación de la frontera callable, reintentos idempotentes, roles, WhatsApp sin configurar, revisión y confirmación obsoletas, backend ausente sin éxito ficticio, baja con tokens válidos, inexistentes o mal formados y fallo de red, casillas y cambio de política, URL y mensajes del padre, privacidad del referente y respuesta obsoleta de origen. Hay pruebas de integración del backend existente que la batería general omite por defecto; no se han tocado servidor ni reglas.

Pendiente del coordinador: integrar backend, reglas y seed de la fase 5; añadir el menú; montar las piezas públicas; escribir consentimiento y origen en la reserva y comprobar la baja a mitad de cola. El flujo completo de lanzamiento, envío capturado, reservas y ventas se debe recorrer cuando se integre el backend. Las fixtures no prueban esos efectos. Limpieza pendiente del host: se han interrumpido las sesiones de Next y Firebase, pero los hijos mantienen abiertos los puertos de la fila 3 (3013, 9104, 8098, 5014, 9214, 4013, 4413, 4513, 9313 y 9513). Cada llamada de la herramienta tiene su propio espacio de PID y no permite ver ni señalizar los hijos de una sesión ya cerrada. No se ha matado ningún proceso ajeno. El coordinador debe localizar los PID que escuchan esos puertos desde el host, comprobar que su directorio de trabajo pertenece a este worktree y enviarles SIGTERM. El arranque de producción en 3013 no pudo hacerse por ese puerto ocupado.

Mensaje de commit propuesto: `feat(web): añadir campañas, segmentos, origen y baja con permiso`.
