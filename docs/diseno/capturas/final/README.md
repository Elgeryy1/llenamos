# Diseño final: capturas y comprobación

Capturas reales con la cuenta de propietario de Taberna Lumbre, los emuladores del proyecto `demo-llenamos` y Next en `http://localhost:3011`. Escritorio 1440×900, tableta táctil 1180×820 y móvil táctil 390×844; todas a **2x**. Se utiliza `require('playwright')` y `chromium.launch()`.

El reloj visual y el instante del seed están fijados al **9 de noviembre de 2026 a las 21:12, Europe/Madrid** para fotografiar la cena en pleno servicio. No se cambia el reloj del sistema ni el de las Functions. Los datos se leen de Firestore y las acciones usan las Functions locales. Solo se oculta el indicador de desarrollo de Next al fotografiar.

| Archivo | Contenido |
|---|---|
| [reservas-lista.png](reservas-lista.png) | Lista y plano con el tema cálido de B |
| [reservas-tiempo.png](reservas-tiempo.png) | Vista por mesas y horas de A con las capas de B |
| [paleta.png](paleta.png) | Ctrl K buscando una reserva del día |
| [atajos.png](atajos.png) | Ayuda de teclado dentro de la pantalla, con desplazamiento |
| [sala.png](sala.png) | Plano con sillas y ficha de una mesa redonda |
| [tableta.png](tableta.png) | Julia Cano elegida, mesa S1 resaltada y botones de 48 px |
| [movil.png](movil.png) | Día y turno en una línea a 390 px |
| [movil-plano.png](movil-plano.png) | Conmutador al plano en el móvil |
| [muestra.png](muestra.png) | Muestrario completo con las piezas nuevas arriba |

## Repetir

Desde la raíz de este worktree, con `firebase.agente1.json` (copia local ignorada de `firebase.json`) y `apps/web/.env.local` configurados para la fila 1: Auth 9102, Firestore 8096, Functions 5012, Storage 9212, UI 4011, Hub 4411, Logging 4511, Eventarc 9311 y Tasks 9511.

```sh
pnpm install
pnpm funciones:build
npx firebase emulators:start --project demo-llenamos --config firebase.agente1.json
```

En otra terminal, dentro del mismo worktree:

```sh
pnpm --filter web exec next dev --port 3011
```

Con ambos procesos listos:

```sh
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8096
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9102
pnpm seed
NODE_OPTIONS=--require=./docs/diseno/capturas/final/reloj.cjs pnpm seed:servicio
node docs/diseno/capturas/final/capturar.cjs
```

Playwright se resuelve del entorno. Si no está en la resolución normal de Node, indica su directorio con `NODE_PATH`. Si el Chromium disponible tiene otra revisión, indica su ejecutable con `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; el script lo pasa a `chromium.launch()`. En esta sesión: Playwright 1.65.0 y Chromium headless 1248, ya instalados. No se añade Playwright a las dependencias del proyecto.

`reloj.cjs` solo cambia la lectura directa de `Date.now()` de `scripts/seed-servicio.ts`, sin alterar los plazos de gRPC. Para otro instante, usa el mismo `LLENAMOS_CAPTURA_INSTANTE` tanto en el seed como en el script de capturas. Las marcas de tiempo de servidor siguen siendo reales.

El script entra por `/entrar` con el botón de demostración del propietario (`Llenamos2026!`), recorre las pantallas, comprueba interacciones y guarda las imágenes. La captura de la muestra es de página completa; las demás tienen el tamaño de su ventana.

## Comprobado en el navegador

- Primer toque elige una reserva y resalta sus mesas; el segundo abre el detalle.
- Tocar una mesa muestra su fila aunque una búsqueda la ocultara. Elegir una reserva de otra zona cambia el plano a esa zona.
- Vista por horas: preferencia conservada tras recargar, bloques que abren el detalle y flechas que desplazan sin cambiar de día.
- Paleta: búsqueda y apertura del detalle; ayuda accesible por `?`; teclas sueltas desactivadas mientras se escribe o hay una ventana abierta.
- Botones de mostrador de al menos 48 px; confirmar, sentar y cambiar mesa a la vista también para una reserva pendiente.
- Móvil sin desbordamiento horizontal, fecha y turno alineados, detalle al primer toque y cambio entre lista y plano.
- Sin errores de ejecución de la aplicación durante el recorrido.

Además, con el reloj real y las Functions locales: **confirmar con Ctrl Intro desde el detalle, cambiar mesa entre propuestas del motor, marcar no presentada con confirmación, «llegó tarde: sentar», terminar y cancelar con confirmación**. Se verificó cada cambio de estado recibido en directo. Los datos se restauraron con los dos seeds antes de fotografiar.

## Validación final

`pnpm install` y `pnpm funciones:build` completados. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` en verde: **643 pruebas aprobadas** (243 de core, 331 de web y 69 de functions). Las 9 pruebas de integración de functions se omiten en el comando habitual según su configuración; las acciones de esta entrega se comprobaron aparte con Playwright y las Functions locales. No se tocaron reglas ni funciones.

El build termina con un aviso de tamaño de un chunk de la web de venta, sin errores. Las nueve imágenes se verificaron como PNG con el doble de la resolución de su ventana (la muestra es de página completa).

## Decisiones y alcance

B sigue siendo la base. La vista partida usa una rejilla CSS estable desde 1024 px, sin separador arrastrable ni `react-resizable-panels`. La única dependencia nueva frente a la base es `cmdk` (`^1.1.1`, MIT), autorizada en el encargo e incorporada en el commit de continuación. No se cambian funciones, reglas, core, precios ni las acciones `actionsFor` y `runStatusAction`.

La aplicación del sistema al resto de pantallas corresponde a la tanda 2. La implementación y la validación de D están completas.

## Estado de entrega

El entorno monta en solo lectura `/srv/LogiQD/llenamos/.git/worktrees/agent-a55cfe8df2f013fd1`. `git add` falla al intentar crear `index.lock`, antes de registrar los cambios. Por ello quedan pendientes **commit y push**; no hay SHA nuevo subido. Todos los cambios y capturas están guardados en este worktree, sobre `13e5ff4`. Se enviaron interrupciones a las sesiones de la web y los emuladores. Las sesiones terminaron, pero sus puertos siguen escuchando y los procesos hijos no son visibles desde el espacio de procesos del agente. Queda pendiente detenerlos desde el host, exclusivamente en los puertos de la fila 1.

Cuando los metadatos de este worktree admitan escritura, desde su raíz:

```sh
git add apps/web docs/diseno
git -c user.name=Elgeryy1 -c user.email=noreply@logiqd.me commit -m "Completa el diseño final con interacciones probadas, guía y capturas reales" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin diseno/final
```

