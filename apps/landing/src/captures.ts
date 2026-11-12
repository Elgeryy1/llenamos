// Capturas reales del panel.
//
// Mientras una vista sea `null`, la web enseña su ilustración (un dibujo hecho con
// componentes y datos de ejemplo de Taberna Lumbre). Para cambiarla por una captura de
// verdad, guarda la imagen en `public/capturas/` y rellena aquí su ruta, su tamaño y un
// texto alternativo que diga lo que se ve. La web pasa sola de «Ilustración» a «Captura».

export type CaptureId = "sala" | "reservas" | "movil"

export interface Capture {
  /** Ruta desde `public`, por ejemplo `/capturas/sala.png`. */
  src: string
  width: number
  height: number
  alt: string
}

export const CAPTURES: Record<CaptureId, Capture | null> = {
  // Sala en directo (/panel/sala), en el héroe.
  sala: {
    src: "/capturas/sala.webp",
    width: 2880,
    height: 1800,
    alt: "Sala de Taberna Lumbre en directo: ocupación, plano con mesas sentadas y ficha de la mesa S2 con su reserva y tiempo de estancia.",
  },
  // Reservas del día (/panel/reservas), en la sección «Demo».
  reservas: {
    src: "/capturas/reservas.webp",
    width: 2880,
    height: 1800,
    alt: "Reservas de la cena de Taberna Lumbre: resumen de cubiertos, llegadas por media hora y lista de reservas junto al plano de mesas.",
  },
  // Reservar desde el móvil (/r/[slug]), en la sección «Demo».
  movil: {
    src: "/capturas/movil.webp",
    width: 780,
    height: 1688,
    alt: "Página móvil para reservar en Taberna Lumbre: selección de dos personas, día de mañana, idiomas y botón Continuar para una reserva a las 13:00.",
  },
}
