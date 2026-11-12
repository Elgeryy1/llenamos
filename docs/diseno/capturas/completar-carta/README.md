# Completar carta, QR y avisos de recogida

Verificación local del agente 5 en `fase2/completar-carta`, el 9 de noviembre de 2026. Solo `demo-llenamos`, con `pnpm seed` y `pnpm seed:servicio`. Sin proveedores externos, Stripe ni cuentas nuevas. El servicio de demostración tiene 43 reservas.

Las 18 capturas son del navegador real a 2x. Escritorio: 1440 × 900, PNG 2880 × 1800. Tableta: 1180 × 820, PNG 2360 × 1640. Móvil: 390 × 844, PNG 780 × 1688. Se oculta únicamente el indicador de desarrollo de Next. `placa-s1.png` es la descarga real de impresión, de 1200 × 1480.

## Arranque y puertos

Copiar `firebase.json` a `firebase.agente5.json`, que está excluido de git, con Auth 9106, Firestore 8100, Functions 5016, Storage 9216, Hub 4415, Logging 4515, Eventarc 9315 y Tasks 9515. La web usa 3015. Para usar exclusivamente puertos de esta fila, se desactiva la UI de emuladores y su 4015 se dedica a `emulators.firestore.websocketPort`. No se usan los puertos del coordinador ni otros worktrees.

En `apps/web/.env.local`, copiar `.env.example` y activar los cuatro `NEXT_PUBLIC_*_EMULATOR_PORT` de esta fila, `NEXT_PUBLIC_EMULATOR_HOST=127.0.0.1` y `NEXT_PUBLIC_SITE_URL=http://localhost:3015`.

```sh
export PNPM_HOME=/tmp/carta-pnpm
export XDG_CONFIG_HOME=/tmp/carta-config
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8100
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9106
export GCLOUD_PROJECT=demo-llenamos
export PUBLIC_APP_URL=http://localhost:3015
pnpm funciones:build
npx firebase emulators:start --project demo-llenamos --config firebase.agente5.json
# En otra terminal con las mismas variables:
pnpm seed
pnpm seed:servicio
pnpm --filter web exec next dev --port 3015
```

La configuración temporal aísla el CLI de Firebase de las credenciales y de las rutas de solo lectura. Chromium: `/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`. Playwright se carga desde la instalación indicada en el encargo. No se han añadido dependencias al proyecto.

## Recorrido comprobado

Entrar en `/entrar` como `encargada@lumbre.test`, contraseña `Llenamos2026!`. El cliente usa un contexto independiente, sin sesión.

| Captura | Qué verifica |
|---|---|
| [01](01-variante-agotada-panel.png) | Carta del personal: botella agotada, copa disponible. El precio y la versión no cambian. |
| [02](02-qr-recuperado-escritorio.png) | Generar S1, recargar, volver a elegir S1 y recuperar exactamente su mismo enlace. |
| [03](03-placa-qr-impresion.png) | Placa con mesa, restaurante y marca. Descargar SVG y PNG desde el navegador. |
| [04](04-busqueda-descripcion-catalan.png) | Buscar «allioli» en catalán encuentra la descripción de las patatas bravas. |
| [05](05-variantes-carta-catalan.png) | Elegir Begudes con el desplegable propio. Copa disponible y ampolla agotada en la carta pública. |
| [06](06-alergenos-contador-movil.png) | Excluir gluten, ver contador, fichas incompletas y explicación. Limpiar repone los platos. |
| [07](07-sugerencia-ingles-recordado.png) | Sugerencia en inglés. Tras cambiar idioma y visitar la carta sin `lang`, se conserva inglés. También se verificó catalán sin parámetro. |
| [08](08-calendario-recogida-ingles.png) | Calendario propio de recogida, traducido a inglés. No usa el selector de fecha del navegador. |
| [09](09-pedido-ingles.png) | Pedido de bravas de 650 céntimos, contacto, consentimiento y revisión de total. |
| [10](10-pedido-recibido.png) | Respuesta confirmada del pedido y enlace privado de seguimiento. |
| [11](11-aceptado-aviso-capturado.png) | Aceptar mediante la callable real. La cola contiene el aviso de aceptación en inglés. El seguimiento distingue captura local de envío. |
| [12](12-listo-seguimiento-ingles.png) | Marchar y dejar listo mediante las callables reales de encargada y cocina. Seguimiento con aviso de listo en la misma cola. |
| [13](13-listo-seguimiento-catalan.png) | El mismo enlace y pedido listo en catalán. |
| [14](14-cola-mensajes.png) | La bandeja existente muestra los avisos de recogida. El correo capturado incluye referencia, hora, importe y enlace original. |
| [15](15-importar-placa-antigua-tableta.png) | Simular el documento anterior que solo conservaba hash eliminando únicamente `tokenSecret` con Admin local. Importar el enlace original desde el panel conserva la placa y permite recuperaciones posteriores. |
| [16](16-qr-movil.png) | Placa y descargas en ancho móvil. |
| [17](17-qr-revocado.png) | Revocar sin sustitución, recuperar de nuevo y comprobar que no existe enlace vigente. Abrir la placa anterior ya no permite consultar la mesa ni pedir. |
| [18](18-carta-escritorio.png) | Búsqueda y sugerencia en castellano, con el diseño Sala cálida. |

Preparación de catálogo desde el editor real: marcar bravas como sugerencia y revisar sus alérgenos y los del agua. El resto conserva su información sin revisar. Por eso el filtro de gluten muestra dos resultados y nueve platos ocultos. No se ha declarado segura ninguna receta real.

La descarga [placa-s1.png](placa-s1.png) se decodificó con un lector independiente y devolvió exactamente el enlace recuperado. La prueba de revocación posterior invalida deliberadamente ese QR de demostración. No reutilizarlo como placa de un restaurante.

Se alteró el token de seguimiento en el navegador y se comprobó que no devolvía el pedido. Los cambios de cocina y aceptación se hicieron contra las callables reales, sin modificar las pantallas asignadas a los otros agentes. Los mensajes locales no salen a Resend ni a Meta. La captura 12 recoge el instante de cola pendiente del segundo aviso; el procesador lo conserva después como capturado.

En la revisión final, el pie público pasa de «Bookings by» a «Powered by» y las líneas listas de recogida dicen «Ready for pickup» en lugar de «on its way»; las capturas de seguimiento conservan la lectura del momento de la prueba.

## Comprobaciones

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
TEST_FIREBASE_EMULATORS=1 GCLOUD_PROJECT=demo-llenamos \
  FIRESTORE_EMULATOR_HOST=127.0.0.1:8100 \
  FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9106 \
  FUNCTIONS_EMULATOR_HOST=127.0.0.1:5016 \
  pnpm --filter functions exec vitest run src/fase2
```

Integración: 32 pruebas en dos archivos. Cubre QR recuperable, importación de legado, revocación, permisos, disponibilidad de variantes y menús, proyección pública, aceptación diferida, deduplicación al deshacer cocina, WhatsApp condicionado a configuración y fallo 503 del proveedor sin perder el pedido. El fallo y la respuesta de WhatsApp se prueban con `fetch` controlado, sin tráfico a proveedores.

Vitest de la web comprueba filtros, limpieza, traducciones, preferencia y la hidratación del idioma con HTML inicial del servidor. Core verifica la exclusión de presencia, trazas, extras y datos incompletos, además de precio y validación de variantes agotadas. Las pruebas del proveedor verifican que WhatsApp use una plantilla configurada con seis variables y no texto libre.

Parar primero los emuladores propios. Las pruebas de reglas borran datos y no deben ejecutarse durante el recorrido de navegador:

```sh
npx firebase emulators:exec --project demo-llenamos --config firebase.agente5.json \
  --only firestore,storage "vitest run --root tests/rules"
```

Las reglas no se han cambiado. Se amplía su prueba para confirmar que ningún rol lee o escribe `takeawaySecrets`, igual que `tableTokens`. La comprobación de entrega incluye Firestore y Storage.

## Cambios de contrato y decisiones

Todos están recogidos en `ARQUITECTURA.md`, sección de fase 2:

1. `MenuItem.featured?`, `MenuItem.allergensReviewed?`, `Variant.soldOut?` y sus proyecciones públicas. Ausencia conserva compatibilidad. Filtrado conservador, contador y menús ocultos al excluir alérgenos. `marcarAgotado` admite `variantId?`, incompatible con `optionId`; los agotados no suben versión.
2. `tableTokens` conserva `tokenSecret?` y `revokedAt?`; hash y secreto pueden ser null al revocar. El servidor custodia el secreto. Nuevas callables `recuperarQrMesa`, `importarQrMesa` y `revocarQrMesa`, con permiso `sala.configurar`, acceso al local y `floor`. Los hashes antiguos no se pueden invertir: se importa el enlace original o se regenera expresamente.
3. Colección privada `takeawaySecrets/{id}` para conservar el enlace original de los avisos. No se cambia el contrato de entrada de los pedidos ni se rotan los antiguos silenciosamente.
4. `Message.takeawayId?`, plantillas `takeaway_accepted` y `takeaway_ready`, claves únicas por evento y canal. `verParaLlevarPublico.notifications?` expone solo canal, plantilla y estado.
5. `PUBLIC_APP_URL` para el origen de seguimiento. WhatsApp requiere las credenciales existentes y `WHATSAPP_TEMPLATE_TAKEAWAY_ACCEPTED` o `WHATSAPP_TEMPLATE_TAKEAWAY_READY`, aprobadas en los idiomas usados. Variables: cliente, restaurante, referencia, fecha y hora, total y URL. Correo sin configurar conserva su estado en la cola.
6. Idioma público recordado por navegador con prioridad del parámetro explícito. Calendario propio y revisión de textos es, ca y en, incluidos errores y recogida.

No se han añadido dependencias. Sin cambios en pantallas de comandero, sala, cocina o barra. Pendiente externo: configurar proveedores y plantillas aprobadas para envío real; importar enlaces de QR anteriores que solo tengan hash y se quieran conservar. No se anuncia entrega real de correo, WhatsApp ni impresión física.

## Retoma después del reinicio

Se ha revisado el commit `6f16aa4` y repetido la verificación en este mismo worktree y los puertos del agente 5. Se corrige además un caso de filtrado: al cambiar o limpiar filtros se cierran las opciones del plato abierto, evitando que sigan visibles cuando el plato queda excluido. Una prueba de componente cubre este recorrido.

Las capturas siguientes son nuevas, a 2x, y complementan las anteriores:

| Captura | Comprobación repetida |
|---|---|
| [19](19-retoma-busqueda-catalan.png) | Buscar por descripción en catalán encuentra las bravas. Móvil. |
| [20](20-retoma-filtros-movil.png) | Excluir gluten deja dos resultados, muestra contador y aviso de fichas incompletas; limpiar repone la carta. Móvil. |
| [21](21-retoma-idioma-recordado.png) | Inglés conservado al volver sin parámetro, sugerencia y búsqueda. Escritorio. |
| [22](22-retoma-qr-tableta.png) | Entrar con la cuenta de encargada, recuperar S1, recargar y recuperar exactamente el mismo enlace. Descargar [PNG real](placa-s1-retoma.png). Tableta. |
| [23](23-retoma-seguimiento-ingles.png) | Seguimiento de un pedido público nuevo aceptado y listo con callables reales. Dos avisos de correo capturados, ambos con su enlace privado original. Móvil. |
| [24](24-retoma-seguimiento-catalan.png) | El mismo seguimiento en catalán. Móvil. |

También se revocó S1 desde el panel sin sustitución y se comprobó que el enlace anterior devuelve acceso denegado. Esta placa de demostración queda deliberadamente revocada. El navegador terminó sin errores de JavaScript. Los pedidos de esta repetición se crearon mediante la callable pública; el envío desde el formulario está documentado en las capturas 08 a 10 del recorrido original.

Verificación repetida: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, en verde; 357 pruebas de core, 444 de web y 71 de Functions sin activar integración. Integración de fase 2: 32 pruebas en verde. Se amplió inicialmente a toda la suite de Functions: 108 pasaron y una prueba de actividad de fase 1 agotó la espera del disparador; al repetir esa suite aislada junto con fase 2, pasaron las 35 pruebas. No se modificó código de fase 1.

Reglas verificadas con el comando anterior y ambos emuladores: 78 pruebas en dos archivos, todas en verde, incluidas las fotos de Storage y la privacidad de los secretos. Se han parado los emuladores y la web propios al terminar.

Mensaje de commit propuesto: `Completar carta pública, recuperación de QR y avisos de recogida`. No se ha hecho commit ni push.
