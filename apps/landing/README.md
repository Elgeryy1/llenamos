# Web de venta de Llenamos (`apps/landing`)

La página para vender Llenamos a restaurantes: qué hace, cómo funciona, precios, preguntas y la
solicitud para ser restaurante piloto. Va aparte del producto (`apps/web`) y no usa Firebase: es
una página estática hecha con Vite, React 19, Tailwind 4 y componentes de shadcn/ui.

```bash
pnpm --filter landing dev        # http://localhost:5181
pnpm --filter landing build      # versión final en apps/landing/dist
pnpm --filter landing lint       # oxlint
pnpm --filter landing typecheck
```

## Acceso al producto

El botón «Acceder» ofrece entradas para LogiQD, propietarios y trabajadores. Comparten el
acceso de la aplicación y cada cuenta conserva sus permisos reales; el enlace no concede roles.
Configura `VITE_APP_URL` con el origen HTTPS de la aplicación **antes de compilar** la landing
(ver `.env.example`). En desarrollo, sin esa variable, apunta a `http://localhost:3000`.
En producción la variable es obligatoria. La landing no recibe contraseñas ni carga Firebase.

## Reglas del contenido

- **Nada inventado presentado como real.** Llenamos aún no tiene clientes: no hay cifras de uso,
  opiniones ni logos de restaurantes. Un dato del sector solo entra con su fuente pública citada.
- **Solo lo que hace el producto** según la fase 1 de `PLAN.md`. Lo de fases posteriores sale como
  «próximamente», sin fechas.
- Las vistas son **capturas reales con datos de Taberna Lumbre**, el restaurante inventado
  de la demo, y lo dicen debajo de cada una. Si una captura falta, se muestra una ilustración
  identificada como tal.
- Castellano llano, sin guiones dentro de las frases y sin mayúsculas en cada palabra.

## Dónde está cada cosa

| Qué | Dónde |
|---|---|
| Todos los textos | `src/content.ts` |
| Secciones de la página | `src/components/site/` |
| Capturas reales del panel (cuando las haya) | `src/captures.ts` y `public/capturas/` |
| Correo del formulario de piloto | `src/lib/pilot.ts` (`mailto:` a `hola@logiqd.me`, la web no envía nada) |
| Aviso legal, privacidad y cookies | `public/legal.html` (los datos que faltan están como `[PENDIENTE: …]`) |
| Imagen para compartir e iconos | `public/og.png`, `public/favicon.svg`, `public/favicon-32.png`, `public/apple-touch-icon.png` |

**Cambiar una ilustración por una captura:** guarda la imagen en `public/capturas/` y rellena su
entrada en `src/captures.ts` (ruta, tamaño y texto alternativo). La leyenda pasa sola de
«Ilustración con datos de ejemplo» a «Captura del panel».

**Imagen para compartir:** sale de `scripts/og.html` (y los iconos, de `scripts/icono.html`).
Para rehacerla, con las dependencias instaladas:

```bash
chrome --headless=new --hide-scrollbars --window-size=1200,630 \
  --screenshot=public/og.png "file:///RUTA/apps/landing/scripts/og.html"
```

## Accesibilidad

Contraste de 4,5:1 o más en el texto, foco visible en todo lo que se usa con teclado, objetivos
táctiles de 44 px, `prefers-reduced-motion` respetado (CSS y animaciones de motion) y contenido
repetido de los carruseles y de la frase animada con `aria-hidden`, para que se lea una sola vez.

## Componentes de terceros

Todos con licencia MIT, copiados de sus repositorios originales y adaptados. Cada archivo dice en
su cabecera de dónde viene y qué se ha cambiado.

| Pieza | Origen | Archivo |
|---|---|---|
| Líneas animadas del héroe y del formulario | [Kokonut UI](https://github.com/kokonut-labs/kokonutui) · Background Paths | `src/components/kokonutui/background-paths.tsx` |
| Franja de canales en movimiento | [Magic UI](https://github.com/magicuidesign/magicui) · Marquee | `src/components/ui/marquee.tsx` |
| Frase que se enciende palabra a palabra | Magic UI · Text Reveal | `src/components/ui/text-reveal.tsx` |
| Cuadrícula de ventajas | Magic UI · Bento Grid | `src/components/ui/bento-grid.tsx` |
| Mensajes que van entrando | Magic UI · Animated List | `src/components/ui/animated-list.tsx` |
| Borde luminoso del plan recomendado | Magic UI · Border Beam | `src/components/ui/border-beam.tsx` |
| Botón del formulario con brillo | Magic UI · Shimmer Button | `src/components/ui/shimmer-button.tsx` |
| Preguntas desplegables | [shadcn/ui](https://github.com/shadcn-ui/ui) · Accordion (sobre Base UI) | `src/components/ui/accordion.tsx` |
| Variantes `data-open` y `data-closed` y animación del acordeón | shadcn/ui · `tailwind.css` | `src/index.css` |
| Unión de clases | shadcn/ui · [`cn`](https://github.com/shadcn-ui/cn) | `src/lib/utils.ts` |
| Panel que se endereza con el scroll | Propio, al estilo de Aceternity · Container Scroll | `src/components/site/container-scroll.tsx` |

Iconos de [Phosphor](https://phosphoricons.com) (MIT) y letra Geist (SIL Open Font License),
servida desde la propia web.
