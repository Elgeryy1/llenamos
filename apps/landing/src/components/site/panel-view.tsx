import type { ReactNode } from "react"
import { CAPTURES, type CaptureId } from "@/captures"
import { cn } from "@/lib/utils"

/**
 * Una vista del panel: la captura real si ya está en `captures.ts`, o la ilustración
 * con datos de ejemplo mientras tanto. Debajo dice siempre cuál de las dos es.
 */
export function PanelView({
  id,
  children,
  frame = (content) => content,
  className,
  captionClassName,
}: {
  id: CaptureId
  /** Ilustración que se enseña mientras no haya captura. */
  children: ReactNode
  /** Marco común a la captura y a la ilustración (la pantalla inclinada, el móvil…). */
  frame?: (content: ReactNode) => ReactNode
  className?: string
  captionClassName?: string
}) {
  const capture = CAPTURES[id]
  return (
    <figure className={cn("flex flex-col", className)}>
      {frame(capture ? (
        <img
          src={capture.src}
          width={capture.width}
          height={capture.height}
          alt={capture.alt}
          loading="lazy"
          decoding="async"
          className="h-auto w-full rounded-xl"
        />
      ) : (
        children
      ))}
      <figcaption className={cn("mt-3 text-center text-xs text-dim", captionClassName)}>
        {capture
          ? `${id === "movil" ? "Captura de la web de reservas" : "Captura del panel"} de Taberna Lumbre, nuestro restaurante de demostración`
          : "Ilustración con datos de demostración"}
      </figcaption>
    </figure>
  )
}
