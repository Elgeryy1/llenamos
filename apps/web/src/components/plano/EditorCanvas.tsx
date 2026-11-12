"use client"

import { chairSpots } from "@/components/sala/Plano"
import { useRef, type KeyboardEvent } from "react"
import { cn } from "@/lib/cn"
import { describeEditorTable, fitBox, MIN_SIZE, type EditorTable } from "@/lib/plano/editor"
import { usePlanoDrag, type DragPreview } from "@/lib/plano/useDrag"

/** Caja de la mesa con la vista previa del arrastre aplicada (sin tocar el borrador). */
function previewBox(t: EditorTable, p: DragPreview | null) {
  if (!p || p.id !== t.id) return t
  if (p.mode === "move") return { ...t, ...fitBox({ x: t.x + p.dx, y: t.y + p.dy, w: t.w, h: t.h }) }
  return {
    ...t,
    w: Math.min(100 - t.x, Math.max(MIN_SIZE, Math.round(t.w + p.dx))),
    h: Math.min(100 - t.y, Math.max(MIN_SIZE, Math.round(t.h + p.dy))),
  }
}

/**
 * Plano editable de una zona. Las mesas se arrastran con el ratón o el dedo, se
 * redimensionan con el asa de la esquina y, con el teclado, se mueven con las
 * flechas (con Mayús, de 5 en 5). Las uniones se dibujan como líneas discontinuas.
 */
export function EditorCanvas({
  label,
  tables,
  names,
  selectedId,
  problemIds,
  onSelect,
  onMove,
  onResize,
  onNudge,
}: {
  label: string
  tables: EditorTable[]
  names: ReadonlyMap<string, string>
  selectedId: string | null
  problemIds: ReadonlySet<string>
  onSelect: (id: string | null) => void
  onMove: (id: string, dx: number, dy: number) => void
  onResize: (id: string, dw: number, dh: number) => void
  onNudge: (id: string, dx: number, dy: number) => void
}) {
  const surface = useRef<HTMLDivElement>(null)
  const { preview, bind } = usePlanoDrag(
    surface,
    (id, mode, dx, dy) => (mode === "move" ? onMove(id, dx, dy) : onResize(id, dx, dy)),
    (id) => onSelect(id),
  )

  const shown = tables.map((t) => previewBox(t, preview))
  const byId = new Map(shown.map((t) => [t.id, t]))
  const lines: Array<[EditorTable, EditorTable]> = []
  for (const t of shown) {
    for (const j of t.joinableWith) {
      const o = byId.get(j)
      if (o && t.id < o.id) lines.push([t, o])
    }
  }

  function onKey(e: KeyboardEvent<HTMLButtonElement>, id: string) {
    const step = e.shiftKey ? 5 : 1
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const m = moves[e.key]
    if (m) {
      e.preventDefault()
      onSelect(id)
      onNudge(id, m[0], m[1])
    } else if (e.key === "Escape") {
      onSelect(null)
    }
  }

  return (
    <div
      className="relative w-full overflow-x-auto rounded-[14px] border bg-surface-sunken shadow-[inset_0_1px_0_0_rgb(0_0_0/0.4)]"
      style={{
        backgroundImage: "radial-gradient(circle at 1px 1px, rgb(244 241 234 / 0.08) 1px, transparent 0)",
        backgroundSize: "22px 22px",
      }}
    >
      <div
        ref={surface}
        className="relative aspect-[16/10] min-w-[600px] select-none"
        role="group"
        aria-label={`Plano de ${label}`}
        onPointerDown={(e) => {
          // Pulsar en el suelo del plano quita la selección.
          if (e.target === e.currentTarget) onSelect(null)
        }}
      >
        <span aria-hidden className="pointer-events-none absolute top-3 left-4 text-[11px] text-muted-foreground">{label}</span>
        <svg aria-hidden className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {lines.map(([a, b]) => (
            <line
              key={`${a.id}-${b.id}`}
              x1={a.x + a.w / 2}
              y1={a.y + a.h / 2}
              x2={b.x + b.w / 2}
              y2={b.y + b.h / 2}
              stroke="var(--primary)"
              strokeOpacity={0.55}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        {shown.map((t) => {
          const selected = t.id === selectedId
          const problem = problemIds.has(t.id)
          const dragging = preview?.id === t.id
          return (
            <div
              key={t.id}
              className={cn("absolute", dragging ? "z-20" : selected ? "z-10" : undefined)}
              style={{ left: `${t.x}%`, top: `${t.y}%`, width: `${t.w}%`, height: `${t.h}%` }}
            >
              {chairSpots(t.shape, t.seats, t.w * 1.6 >= t.h).map((chair, i) => (
                <span key={i} aria-hidden style={chair.style} className={cn("pointer-events-none absolute h-[7px] w-[18px] rounded-[3px]", t.enabled ? "bg-foreground/[0.13]" : "bg-foreground/[0.06]")} />
              ))}
              <button
                type="button"
                {...bind(t.id, "move")}
                onKeyDown={(e) => onKey(e, t.id)}
                onClick={(e) => { if (e.detail === 0) onSelect(t.id) }}
                aria-pressed={selected}
                aria-label={describeEditorTable(t, names)}
                title={describeEditorTable(t, names)}
                className={cn(
                  "relative flex size-full touch-none cursor-grab flex-col items-center justify-center gap-0.5 overflow-hidden border text-center shadow-soft active:cursor-grabbing",
                  "transition-[border-color,background-color,box-shadow] duration-200 ease-(--ease-llenamos) focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring",
                  t.shape === "round" ? "rounded-full px-[10%] py-[16%]" : "rounded-lg px-2 py-1.5",
                  t.enabled ? "border-foreground/20 bg-[#1f1c17]" : "border-dashed bg-transparent opacity-60",
                  selected ? "border-foreground/60 shadow-float outline-2 outline-offset-4 outline-foreground/80" : problem ? "border-destructive" : "hover:border-foreground/40",
                )}
              >
                <span className="cifra w-full truncate text-[13px] leading-tight font-semibold">{t.name || "Sin nombre"}</span>
                <span className="cifra w-full truncate text-[11px] leading-tight text-muted-foreground">{t.enabled ? `${t.seats} pl.` : "Cerrada"}</span>
              </button>
              {selected ? (
                <span
                  {...bind(t.id, "resize")}
                  aria-hidden
                  title="Arrastra para cambiar el tamaño"
                  className="absolute -right-3 -bottom-3 flex size-6 touch-none cursor-nwse-resize items-center justify-center after:size-3 after:rounded-[3px] after:border after:border-foreground/60 after:bg-popover pointer-coarse:-right-5 pointer-coarse:-bottom-5 pointer-coarse:size-11"
                />
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
