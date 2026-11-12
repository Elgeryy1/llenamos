"use client"

/**
 * Arrastrar con el ratón, el dedo o el lápiz (Pointer Events), sin dependencias.
 *
 * Mientras se arrastra solo se pinta la vista previa (estado local); al soltar se
 * llama a `onEnd` con el desplazamiento total en puntos de la rejilla 0–100, y el
 * borrador cambia una sola vez. Un toque sin moverse (menos de 4 px) es un clic.
 * El contenedor del plano lleva `touch-action: none` para que el dedo no haga scroll.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import { pixelsToGrid } from "./editor"

export type DragMode = "move" | "resize"

export interface DragPreview {
  id: string
  mode: DragMode
  /** Desplazamiento en puntos de la rejilla. */
  dx: number
  dy: number
}

const CLICK_SLOP_PX = 4

export function usePlanoDrag(
  surface: RefObject<HTMLElement | null>,
  onEnd: (id: string, mode: DragMode, dx: number, dy: number) => void,
  onClick: (id: string) => void,
) {
  const [preview, setPreview] = useState<DragPreview | null>(null)
  const start = useRef<{ id: string; mode: DragMode; x: number; y: number; moved: boolean; pointer: number } | null>(null)

  function delta(e: ReactPointerEvent) {
    const s = start.current
    const rect = surface.current?.getBoundingClientRect()
    if (!s || !rect) return { dx: 0, dy: 0, px: 0 }
    const px = Math.hypot(e.clientX - s.x, e.clientY - s.y)
    return { ...pixelsToGrid(e.clientX - s.x, e.clientY - s.y, rect.width, rect.height), px }
  }

  function bind(id: string, mode: DragMode) {
    return {
      onPointerDown(e: ReactPointerEvent<HTMLElement>) {
        // Solo el botón principal (o el dedo); el resto, para el navegador.
        if (e.button !== 0) return
        e.stopPropagation()
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // Sin captura sigue funcionando mientras el puntero no salga de la mesa.
        }
        start.current = { id, mode, x: e.clientX, y: e.clientY, moved: false, pointer: e.pointerId }
      },
      onPointerMove(e: ReactPointerEvent<HTMLElement>) {
        const s = start.current
        if (!s || s.pointer !== e.pointerId) return
        const d = delta(e)
        if (!s.moved && d.px < CLICK_SLOP_PX) return
        s.moved = true
        setPreview({ id: s.id, mode: s.mode, dx: d.dx, dy: d.dy })
      },
      onPointerUp(e: ReactPointerEvent<HTMLElement>) {
        const s = start.current
        if (!s || s.pointer !== e.pointerId) return
        // El desplazamiento se mide antes de olvidar el punto de partida.
        const d = delta(e)
        start.current = null
        setPreview(null)
        if (!s.moved) {
          if (s.mode === "move") onClick(s.id)
          return
        }
        onEnd(s.id, s.mode, d.dx, d.dy)
      },
      onPointerCancel() {
        start.current = null
        setPreview(null)
      },
    }
  }

  return { preview, bind }
}
