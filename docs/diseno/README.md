# Diseño de Llenamos · sala cálida

Este es el sistema de diseño del panel desde la etapa 0. Lo eligió el usuario el 2026-11-09: la propuesta **B «Sala cálida»** como base, con la **línea de tiempo** y la **paleta Ctrl K** de la propuesta A y la **vista partida** lista y plano de la propuesta C, todo en el tema oscuro cálido de B (el tema claro de C no entra). Las tres propuestas siguen en sus ramas (`diseno/propuesta-a`, `-b`, `-c`, con su README en `docs/diseno/propuestas/<x>/`).

Con este documento y [`componentes.md`](componentes.md) se tiene que poder llevar cualquier pantalla al sistema **sin mirar el código de Reservas ni de Sala**. Todo se ve funcionando en `/panel/muestra` (propietario o encargado). Capturas reales del resultado en [`capturas/final/`](capturas/final/).

Los `.dc.html` de esta carpeta son el lienzo de marca original (colores, letra, logo y tono). No son el objetivo visual: las pantallas se montan con componentes de shadcn y de registros compatibles, con la marca puesta en sus variables.

| Archivo del lienzo | Pantalla | Ruta |
|---|---|---|
| `Main.dc.html` | Reservas del día | `/panel/reservas` |
| `Sala.dc.html` | Sala en directo | `/panel/sala` |
| `Inicio.dc.html` | Inicio del servicio | `/panel` |
| `Reserva.dc.html` | Reservar en el móvil | `/r/[slug]` |
| `Confirmada.dc.html` | Reserva confirmada | `/r/[slug]/reserva/[ref]` |
| `Fundamentos.dc.html` | Colores, letra, botones, estados | todo |

## La idea en cinco líneas

1. Que se note que es para un restaurante: el plano manda, con cada mesa dibujada con su forma y sus sillas.
2. Capas cálidas escalonadas con sombras suaves, no una plantilla plana de bordes.
3. Filas ricas en vez de tablas: hora grande en Geist Mono, avatar, etiquetas, agrupadas por media hora.
4. El tiempo manda: el reloj del local siempre a la vista, «ahora» en ámbar en todas las vistas.
5. Rápido con teclado (Ctrl K y atajos) y con el dedo (vista partida y botones de 48 px en la tableta).

## Fundamentos

### Capas

Cinco niveles, todos del mismo tono tostado. Cada uno un punto más claro que el de debajo:

| Capa | Color | Clase | Para qué |
|---|---|---|---|
| Hundida | `#0f0e0a` | `bg-surface-sunken` | Fondo del plano, carriles, barras de progreso, separadores de media hora (`bg-surface-sunken/50`), control segmentado (`/60`) |
| Fondo | `#131209` | `bg-background` | La página |
| Barra lateral | `#161512` | `bg-sidebar` | Menú |
| Bloque | `#1b1914` | `bg-card` o la utilidad `superficie` | Cada bloque de la página |
| Alzada | `#211e18` | `bg-surface-raised` | Fila al pasar o elegida, opción elegida, barra de la reserva elegida |
| Flotante | `#24211b` | `bg-popover` | Paneles laterales, menús, paleta, ventanas |

`--accent` (`#2c2820`) es el fondo al pasar por encima de elementos de menú de shadcn.

### Sombras suaves

Se separan capas con **borde fino y sombra suave**, nunca con sombras grandes, degradados, brillos ni cristal (los fondos de ventanas y paneles se oscurecen sin desenfocar).

| Clase | Variable | Dónde |
|---|---|---|
| `shadow-soft` | `--sombra-suave`: filo claro arriba de 1 px, sombra corta y sombra larga muy difusa | Bloques, botones principales, opción elegida, mesas del plano |
| `shadow-float` | `--sombra-flotante` | Lo que flota: paneles, paleta, la mesa o el bloque elegidos |
| `superficie` | `bg-card`, borde fino, radio 14, `shadow-soft` | El bloque estándar. Úsalo en vez de `Card` para bloques grandes de una pantalla |

Bordes: `border` (blanco cálido al 7 %) para todo; `border-input` (12 %) en campos.

### Tamaños

| Qué | Tamaño |
|---|---|
| Línea de encima del título (día, local) | 13 px en el móvil, 14 en escritorio, `text-muted-foreground` con lo importante en `text-soft-foreground` |
| Título de página (cuenta algo) | 24 px en el móvil, 32 px desde `sm`, 600, `tracking-tight`, `text-balance` |
| Título de bloque | 16 a 18 px, 600 |
| Cuerpo | 14 px; nombre en una fila 15 px, 500 |
| Horas de una fila | 17 a 18 px Geist Mono (`cifra`), 500 |
| Cifra grande de un resumen | 36 a 48 px Geist Mono, 600 |
| Etiquetas | 11,5 px, alto 18, radio 4 |
| Texto pequeño de apoyo | 12 px (`text-xs`); 11 px solo dentro de mesas o contadores |
| Botones | 36 px (`size="lg"`) en el panel; **48 px** (`h-12`) en el mostrador (barra de la reserva elegida) y en la página pública |
| Pantallas táctiles | 44 px mínimo en todo control (lo pone `globals.css` solo) |

Radios: 4 etiquetas, 6 controles pequeños, 8 botones y campos, 10 bloques pequeños y botones de 48, **14 bloques grandes** (`superficie`, plano, paleta, paneles), 12 en el móvil.

### Ancho

- Sala y Reservas (las pantallas del servicio) usan hasta **1600 px**. La lista está en `WIDE` de `components/panel/PanelShell.tsx`; añade ahí otra ruta solo si es una pantalla de servicio con plano o línea de tiempo.
- El resto del panel va en **1152 px** (`max-w-6xl`), centrado.
- Margen lateral: 16 px en el móvil, 24 en tableta y 32 en escritorio. Arriba 24, 32 en escritorio.
- En la tableta apaisada (768 a 1279 px) la barra lateral empieza plegada a iconos.

### Color

| Color | Valor | Clase | Solo para |
|---|---|---|---|
| Ámbar | `#f0a35e` | `bg-primary`, `text-warning` | La **única** acción principal de la pantalla (texto `#1a1408`), «ahora», retrasos, avisos |
| Verde | `#8fc7a0` | `text-success`, `bg-success` | Sentados, guardado, correcto |
| Rojo cálido | `#e8857a` | `text-destructive` | Alergia, cancelar, error, «no vino» |
| Texto | `#f4f1ea` | `text-foreground` | Lo que se lee |
| Texto suave | `#d6d2c8` | `text-soft-foreground` | Dato secundario que se tiene que leer |
| Texto apagado | `#a39f95` | `text-muted-foreground` | Etiquetas, ayudas (cumple 4,5:1) |
| Ceniza | `#5f5b53` | `bg-ash` | Solo puntos, barras de lo pasado y adornos. **Nunca texto** |

Fondos suaves de estado: `bg-success/[0.11]`, `bg-warning/[0.13]`, `bg-destructive/12`, con su borde al 50 o 70 %.

### Estado: punto y palabra; en el plano, color, icono y palabra

- En listas y fichas, el estado de una reserva es un **punto de 8 px y una palabra** (`ReservationStatusDot`): por llegar (aro gris), sin confirmar, retraso N min (ámbar), sentada (verde), terminada (ceniza, fila al 60 %), cancelada (aro rojo).
- En el **plano**, cada mesa dice su estado con **color, icono Phosphor y palabra** (`ESTADO_MESA` en `components/sala/Plano.tsx`): libre, reservada, llega pronto, va tarde, sentados, pasan de hora, deshabilitada. Un punto no se ve a un metro de la pantalla en mitad del servicio.
- Si la mesa es pequeña, primero se esconde el cliente, luego el icono, y la palabra pasa a su forma corta («Pronto», «Tarde», «Alargan»). **La palabra nunca se va.**
- En las mesas redondas el texto va en la franja central del círculo (10 % de margen a los lados, 16 % arriba y abajo), recortado con puntos suspensivos: nunca roza el borde.
- En la línea de tiempo, cada bloque lleva una barra de color a la izquierda y el estado se dice en su nombre accesible y en la leyenda. Los bloques de quien sigue sentado se alargan hasta ahora y se separan en carriles si coinciden con otra reserva, sin taparse.

### Letra e iconos

Geist para el texto y **Geist Mono con cifras tabulares** (clase `cifra`) para horas, mesas, personas, importes, referencias y atajos. Iconos Phosphor de 16 px (14 en etiquetas), solo donde ayudan; con `aria-hidden` si van con palabra.

### Movimiento

Corto (150 a 300 ms) y con `ease-(--ease-llenamos)` (`cubic-bezier(0.32, 0.72, 0, 1)`). Solo donde informa: la ficha o el panel entra, la mesa o el bloque elegido se levanta 1 px con `shadow-float`. Se respeta `prefers-reduced-motion`.

## Reglas

1. Un solo botón ámbar por pantalla (o por barra de mostrador): lo que toca hacer ahora. El resto `outline` (con `bg-card shadow-soft`) o `ghost`.
2. Bloques en `superficie`; dentro, filas separadas con `divide-y`, no tarjetas dentro de tarjetas.
3. Una fila por reserva, cliente o mensaje, agrupadas (por turno, por media hora, por día) con un separador que dice algo («20:30 · 26 cubiertos»).
4. El estado nunca va solo con color (ver arriba).
5. Títulos que cuentan algo («55 cubiertos en la cena hoy», «15 mesas ocupadas»), no «Panel».
6. Castellano llano, sin guiones dentro de las frases y sin mayúsculas en cada palabra.
7. El reloj del local está en la cabecera; en las pantallas de servicio, «En directo · 21:12» junto a los controles.
8. Lo que se toca con prisa (mostrador, tableta) mide 48 px; lo demás, 36 en escritorio y 44 en táctil.
9. Las filas se adaptan al ancho de **su caja** (container queries, `@container/lista`), no al de la pantalla: así la misma lista vale a todo el ancho, en una columna y en el móvil.
10. Nada de efectos de página de venta (brillos, partículas, degradados animados, cristal).

## Cómo es una pantalla

```
Cabecera fija (56 px): menú · restaurante / sección · [Buscar o ir a… Ctrl K] · ? · (● lun 9 nov 21:12)
┌──────────────────────────────────────────────────────────────────────────────┐
│ Hoy, lunes 9 de noviembre · Centro                         [+ Nueva reserva N] │  ← línea de encima, título, acción ámbar
│ 55 cubiertos en la cena hoy                                                    │
│ [1 sin confirmar] [2 sin mesa]                                                 │  ← etiquetas de aviso (Tag tone="aviso")
│ [‹ lunes 9 de noviembre ›] [Comida|Cena|Todo el día] [Lista|Tiempo] ● En directo│  ← controles en una fila
│ ┌ superficie ────────────────────────────────────────────────────────────────┐ │
│ │ resumen en tres zonas separadas por border-l (no tres tarjetas)            │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│ Todas 22 · Por llegar 7 · …                          [Nombre, teléfono…   /]   │  ← barra fija al bajar (sticky)
│ ┌ superficie con las filas ───────────┐  ┌ superficie con el plano (sticky) ┐  │
│ │ 20:00 ─────────────── 26 cubiertos  │  │ [Sala|Terraza]                   │  │
│ │ 20:00  Bernat Riera  ☏      2   S1  │  │  mesas con sillas                 │  │
│ └─────────────────────────────────────┘  │ barra de la reserva elegida (48) │  │
│                                          └──────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Esqueleto en código, con clases y piezas reales:

```tsx
<header className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 sm:mb-6">
  <div className="min-w-0">
    <p className="mb-1.5 text-[13px] text-muted-foreground sm:text-sm"><span className="text-soft-foreground">Hoy, lunes 9 de noviembre</span> · Centro</p>
    <h1 className="text-[24px] leading-tight font-semibold tracking-tight text-balance sm:text-[32px]">12 clientes nuevos esta semana</h1>
  </div>
  <Button size="lg" className="shadow-soft max-sm:w-full"><PlusIcon aria-hidden weight="bold" /> Nuevo cliente</Button>
</header>

<section className="superficie overflow-hidden">
  <h2 className="border-b px-5 py-3 text-base font-semibold">Llegadas</h2>
  <ul className="divide-y">
    <li><button className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors duration-150 ease-(--ease-llenamos) hover:bg-surface-raised">…</button></li>
  </ul>
</section>
```

Para cifras en fila, una sola `superficie` con zonas separadas por `border-l` (como el resumen de Reservas o el pulso de Sala), no cuatro tarjetas iguales.

## Reservas: lista, tiempo y vista partida

- **Conmutador de vista** (`SegmentedControl` con icono): Lista y Tiempo; en pantallas estrechas también Plano. Se recuerda por persona en el navegador (`localStorage`, clave `llenamos:reservas:vista:<uid>`). Atajo `V`.
- **Lista** (de B): un turno por `superficie`, un separador por media hora con sus cubiertos y una fila rica por reserva.
- **Tiempo** (de A, restilada): una fila por mesa y por zona, horas en horizontal, cada reserva un bloque de su llegada a su salida prevista, la línea ámbar de «ahora» y las llegadas por media hora arriba. Lo que no cumple el filtro o la búsqueda se queda apagado en su sitio. Pulsar un bloque abre el detalle de siempre.
- **Vista partida** (de C, a partir de 1024 px): la lista a la izquierda y el plano a la derecha, fijo al bajar. El primer toque en una reserva la **elige** (su mesa se resalta con un aro y el plano cambia a su zona); el segundo abre el detalle. Tocar una mesa elige su reserva y trae su fila a la vista, quitando los filtros que la ocultaban. Debajo del plano, la **barra de la reserva elegida** con botones de 48 px: la acción principal (sentar, confirmar, terminar o «llegó tarde: sentar»), cambiar mesa, cancelar y «no vino», y «Detalle».
- **Móvil**: lista sola, con el conmutador Lista · Plano · Tiempo. Tocar abre el detalle. El día va corto («lun 9 nov») y el turno con «Todo» para que **día y turno quepan en una línea a 390 px**.

## Teclado

La paleta (**Ctrl K** o **⌘K**) busca reservas del día, va a cualquier sección, cambia de local y lanza las acciones de la pantalla. **?** enseña todos los atajos. Las teclas sueltas **no cuentan mientras se escribe en un campo ni con una ventana, panel o menú abiertos**; las combinaciones con Ctrl o ⌘ sí.

| Dónde | Tecla | Qué hace |
|---|---|---|
| Todo el panel | Ctrl K · ⌘K | Buscar o ir a |
| Todo el panel | ? | Ver los atajos |
| Todo el panel | G y una letra | Ir a: I inicio, R reservas, S sala, E lista de espera, C clientes, M mensajes, P plano, H horarios, A actividad, Q equipo |
| Todo el panel | Ctrl B · ⌘B | Plegar o abrir el menú |
| Reservas | N | Nueva reserva |
| Reservas | / | Buscar en el día (Esc borra) |
| Reservas | V | Lista o tiempo |
| Reservas | T · ← · → | Hoy, día anterior, día siguiente |
| Reservas | 1 · 2 · 3 | Turno (comida, cena, todo el día) |
| Reservas | J · K | Bajar y subir por la lista; Intro abre o elige |
| Reservas (vista partida) | Esc · Ctrl Intro | Quitar la reserva elegida · su acción principal |
| Detalle de una reserva | Ctrl Intro · ⌘ Intro | La acción principal |

Teclas libres para otras pantallas: cualquier letra que no esté arriba. Antes de usar una, mira que no choque con «G y una letra». Cómo añadir atajos y órdenes: [`componentes.md`](componentes.md#paleta-y-atajos).

## Reglas del diseño anterior que cambiaron

1. «Bordes finos en vez de sombras» pasa a **borde fino y sombra suave** (capas).
2. Superficie `#181818` gris pasa a **`#1b1914` tostado**.
3. «Listas y tablas antes que tarjetas» se queda a medias: una fila por reserva, pero sin rejilla de tabla; las tablas (`DataTable`) siguen para listas largas y administrativas.
4. El estado con punto y palabra se amplía en el plano a **color, icono y palabra**.
5. Títulos de 26 a **32 px**, horas de fila a 17–18 px, cifras de resumen a 48 px. Radios de 14 en bloques grandes.
6. Ancho de 1600 px en las pantallas de servicio.
7. Fondos de ventanas y paneles **sin desenfoque**.

## Capturas

La web de venta usa las capturas reales de Sala y Reservas de `capturas/final/` y la vista
móvil de `capturas/z4-publica/horas-movil.png`, convertidas a WebP sin pérdida y sin reducir
su resolución 2x. `apps/landing/src/captures.ts` declara sus dimensiones reales y textos
alternativos. Todas se identifican como «Captura» con datos del restaurante de demostración.
Revisión en escritorio y móvil: [`capturas/landing/`](capturas/landing/README.md).

Los campos de fecha y hora de Horarios y Nueva reserva usan las piezas propias del tema.
Calendarios de 44 px en táctil en el panel y de 48 px en la web pública; los desplegables
públicos mantienen también 48 px en sus menús. Recorridos y capturas:
[`capturas/controles/`](capturas/controles/README.md). API y origen de las piezas en
[`componentes.md`](componentes.md#fechas-commondate-picker).

`capturas/final/`, todas reales a 2x con los emuladores, `pnpm seed` y `pnpm seed:servicio` (propietario de Taberna Lumbre). El servicio se generó y se fotografió con el reloj a las 21:12 del 9 de noviembre, en plena cena. El [procedimiento reproducible y las comprobaciones](capturas/final/README.md) incluyen los scripts, los puertos y las decisiones:

| Archivo | Qué enseña |
|---|---|
| `reservas-lista.png` | Reservas a 1440×900: lista y plano a la vez |
| `reservas-tiempo.png` | La línea de tiempo por mesa con «ahora» |
| `paleta.png` | La paleta buscando «pau» |
| `atajos.png` | La lista de atajos (?) |
| `sala.png` | Sala en directo con la ficha de una mesa redonda abierta |
| `tableta.png` | Reservas a 1180×820: vista partida con una reserva elegida, su mesa resaltada y la barra de 48 px |
| `movil.png` | Reservas a 390×844: día y turno en una línea |
| `movil-plano.png` | El plano en el móvil |
| `muestra.png` | Las piezas nuevas en `/panel/muestra` |
