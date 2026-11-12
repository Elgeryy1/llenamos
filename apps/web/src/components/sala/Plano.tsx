"use client"

import {
  CalendarCheckIcon,
  CircleDashedIcon,
  ClockIcon,
  ForkKnifeIcon,
  HourglassHighIcon,
  ProhibitIcon,
  WarningIcon,
  type Icon,
} from "@phosphor-icons/react"
import type { CSSProperties } from "react"
import { cn } from "@/lib/cn"
import type { TableDoc } from "@/lib/data/parse"
import { TABLE_STATE_LABEL, type TableLiveState } from "@/lib/reservas/sala"
import { describeTable, tableBox } from "@/lib/sala/plano"

/** Lo que pasa en una mesa ahora (fase 1): estado, texto corto y progreso de la comida. */
export interface PlanoLiveTable {
  serviceLabel?: string
  state: TableLiveState
  /** «Familia Roca · 27 min», «21:30 Pau Ferrer», «libre». */
  line: string
  /** 0 a 1 mientras están sentados. */
  progress: number
  /** Si al pulsarla hay una reserva que abrir. */
  clickable: boolean
  /** Nombre del cliente que manda en la mesa (sentado o el siguiente). */
  guest?: string
  /** Dato corto a la derecha del nombre de la mesa: «27′» sentados, «14:48» la llegada. */
  detail?: string
  /** Personas de la reserva sentada: tantas sillas ocupadas. */
  party?: number
}

/** Cómo se ve cada estado: color, icono y palabra (nunca solo color). */
/** `short`: la palabra cuando la mesa es pequeña (plano estrecho de la vista partida). */
export const ESTADO_MESA: Record<TableLiveState, { label: string; short: string; icon: Icon; text: string; top: string; chair: string; dot: string }> = {
  free: { label: "Libre", short: "Libre", icon: CircleDashedIcon, text: "text-muted-foreground", top: "border-foreground/14 bg-[#1d1b16]", chair: "bg-foreground/12", dot: "border border-foreground/40" },
  reserved: { label: "Reservada", short: "Reserva", icon: CalendarCheckIcon, text: "text-soft-foreground", top: "border-foreground/22 bg-[#221f19]", chair: "bg-foreground/16", dot: "bg-soft-foreground/70" },
  soon: { label: "Llega pronto", short: "Pronto", icon: ClockIcon, text: "text-warning", top: "border-dashed border-warning/80 bg-warning/[0.07]", chair: "bg-warning/30", dot: "border border-dashed border-warning" },
  late: { label: "Va tarde", short: "Tarde", icon: WarningIcon, text: "text-warning", top: "border-warning bg-warning/[0.13] ring-2 ring-warning/20", chair: "bg-warning/45", dot: "bg-warning" },
  seated: { label: "Sentados", short: "Sentados", icon: ForkKnifeIcon, text: "text-success", top: "border-success/60 bg-success/[0.11]", chair: "bg-success/75", dot: "bg-success" },
  overtime: { label: "Pasan de hora", short: "Alargan", icon: HourglassHighIcon, text: "text-warning", top: "border-warning/70 bg-success/[0.08]", chair: "bg-warning/70", dot: "bg-warning/70 ring-2 ring-success/50" },
  disabled: { label: "Deshabilitada", short: "Cerrada", icon: ProhibitIcon, text: "text-muted-foreground", top: "border-foreground/15 bg-transparent", chair: "bg-foreground/8", dot: "border border-dashed border-foreground/30" },
}

interface ChairSpot {
  style: CSSProperties
}

/**
 * Sillas alrededor de la mesa según sus plazas y su forma. Redonda: repartidas en círculo.
 * Rectangular: en los lados largos y, a partir de seis plazas, una en cada cabecera.
 */
export function chairSpots(shape: TableDoc["shape"], seats: number, wide: boolean): ChairSpot[] {
  const n = Math.max(0, Math.min(seats, 14))
  const gap = 9 // px entre el borde de la mesa y el centro de la silla
  if (shape === "round") {
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2
      const c = Math.cos(a)
      const s = Math.sin(a)
      return {
        style: {
          left: `calc(50% + ${c.toFixed(3)} * (50% + ${gap}px))`,
          top: `calc(50% + ${s.toFixed(3)} * (50% + ${gap}px))`,
          transform: `translate(-50%, -50%) rotate(${((a * 180) / Math.PI + 90).toFixed(1)}deg)`,
        },
      }
    })
  }
  const ends = n >= 6 ? 2 : 0
  const sideA = Math.ceil((n - ends) / 2)
  const sideB = n - ends - sideA
  const along = (count: number, side: "a" | "b"): ChairSpot[] =>
    Array.from({ length: count }, (_, i) => {
      const p = `${(((i + 1) / (count + 1)) * 100).toFixed(2)}%`
      const out = side === "a" ? `-${gap}px` : `calc(100% + ${gap}px)`
      return {
        style: wide
          ? { left: p, top: out, transform: "translate(-50%, -50%)" }
          : { top: p, left: out, transform: "translate(-50%, -50%) rotate(90deg)" },
      }
    })
  const head = (side: "a" | "b"): ChairSpot => {
    const out = side === "a" ? `-${gap}px` : `calc(100% + ${gap}px)`
    return { style: wide ? { top: "50%", left: out, transform: "translate(-50%, -50%) rotate(90deg)" } : { left: "50%", top: out, transform: "translate(-50%, -50%)" } }
  }
  return [...along(sideA, "a"), ...along(sideB, "b"), ...(ends ? [head("a"), head("b")] : [])]
}

/**
 * Plano de una zona: cada mesa en su sitio (rejilla 0–100), dibujada con su forma y sus
 * sillas. En pantallas estrechas el plano mantiene su ancho y se desplaza dentro de su caja.
 * Con `live`, cada mesa dice su estado con color, icono y palabra, y se puede pulsar.
 */
export function Plano({
  label,
  tables,
  names,
  live,
  onSelect,
  selectedId,
  selectedIds,
  compact = false,
}: {
  label: string
  tables: TableDoc[]
  names: ReadonlyMap<string, string>
  live?: ReadonlyMap<string, PlanoLiveTable>
  onSelect?: (tableId: string) => void
  /** Mesa elegida (su ficha está abierta al lado). */
  selectedId?: string | null
  /** Mesas de la reserva elegida en la lista (vista partida): pueden ser varias unidas. */
  selectedIds?: readonly string[]
  /**
   * Plano estrecho (vista partida de la tableta): sin ancho mínimo, encoge con su columna
   * y cada mesa esconde lo que no le cabe (primero el cliente, nunca la palabra del estado).
   */
  compact?: boolean
}) {
  const fit = fitView(tables)
  const picked = new Set(selectedIds ?? [])
  if (selectedId) picked.add(selectedId)
  return (
    <div className="no-scrollbar overflow-x-auto rounded-[14px] border bg-surface-sunken shadow-[inset_0_1px_0_0_rgb(0_0_0/0.4)]">
      <div
        className={cn("relative", compact ? "min-w-0" : "min-w-[680px]")}
        style={{
          aspectRatio: fit.aspect,
          backgroundImage: "radial-gradient(rgb(244 241 234 / 0.07) 1px, transparent 1.2px)",
          backgroundSize: "22px 22px",
        }}
      >
        <span aria-hidden className="pointer-events-none absolute top-3 left-4 text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
        <div className={cn("absolute", compact ? "inset-x-4 top-8 bottom-4" : "inset-x-6 top-9 bottom-6")}>
          {/* Encuadre: el plano se acerca a la zona donde están las mesas, sin mover sus coordenadas. */}
          <ul aria-label={`Plano de ${label}`} className="absolute" style={fit.style}>
            {tables.map((t) => (
              <Mesa key={t.id} table={t} names={names} live={live?.get(t.id)} onSelect={onSelect} selected={picked.has(t.id)} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

/**
 * Encuadre del plano: el rectángulo (en la rejilla 0–100) que ocupan las mesas, con margen
 * para las sillas, y la proporción de la caja. La rejilla original es de 16 por 10.
 */
export function fitView(tables: ReadonlyArray<Pick<TableDoc, "x" | "y" | "w" | "h">>): { aspect: number; style: CSSProperties } {
  if (tables.length === 0) return { aspect: 16 / 10, style: { inset: 0 } }
  let minX = Math.min(...tables.map((t) => t.x)) - 4
  let maxX = Math.max(...tables.map((t) => t.x + t.w)) + 4
  let minY = Math.min(...tables.map((t) => t.y)) - 6
  let maxY = Math.max(...tables.map((t) => t.y + t.h)) + 6
  // Nunca más lejos que el plano entero.
  minX = Math.max(minX, 0)
  minY = Math.max(minY, 0)
  maxX = Math.min(maxX, 100)
  maxY = Math.min(maxY, 100)
  let spanX = maxX - minX
  let spanY = maxY - minY
  // Proporción entre 1,5 y 2,4: si el encuadre queda muy estrecho o muy bajo, se abre.
  const ratio = (spanX * 1.6) / spanY
  if (ratio > 2.4) {
    const target = (spanX * 1.6) / 2.4
    minY -= (target - spanY) / 2
    spanY = target
  } else if (ratio < 1.5) {
    const target = (spanY * 1.5) / 1.6
    minX -= (target - spanX) / 2
    spanX = target
  }
  const pct = (n: number) => `${n.toFixed(3)}%`
  return {
    aspect: (spanX * 1.6) / spanY,
    style: { left: pct((-minX / spanX) * 100), top: pct((-minY / spanY) * 100), width: pct((100 / spanX) * 100), height: pct((100 / spanY) * 100) },
  }
}

function Mesa({
  table: t,
  names,
  live: l,
  onSelect,
  selected,
}: {
  table: TableDoc
  names: ReadonlyMap<string, string>
  live?: PlanoLiveTable
  onSelect?: (tableId: string) => void
  selected: boolean
}) {
  const description = l ? `${describeTable(t, names)}. ${TABLE_STATE_LABEL[l.state]}: ${l.line}${l.serviceLabel ? `. ${l.serviceLabel}` : ""}` : describeTable(t, names)
  const round = t.shape === "round"
  const box = tableBox(t)
  const wide = t.w * 1.6 >= t.h
  const state: TableLiveState | null = l ? l.state : t.enabled ? null : "disabled"
  const baseLook = state ? ESTADO_MESA[state] : null
  const look = l?.serviceLabel && baseLook ? { ...baseLook, label: l.serviceLabel, short: l.serviceLabel === "Pendiente de aprobación" ? "Aprobar" : l.serviceLabel === "Listo para servir" ? "Listo" : l.serviceLabel === "Cuenta pedida" ? "Cuenta" : l.serviceLabel, text: "text-warning", top: "border-warning/70 bg-warning/[0.13]", icon: WarningIcon } : baseLook
  const occupied = l && (l.state === "seated" || l.state === "overtime") ? (l.party ?? t.seats) : 0
  const chairs = chairSpots(t.shape, t.seats, wide)
  const clickable = Boolean(l && l.clickable && onSelect)
  const StateIcon = look?.icon

  // Redonda: el texto va en la franja central del círculo (10 % de margen a los lados y 16 %
  // arriba y abajo), donde la cuerda es casi el diámetro, así nunca roza el borde. Cada línea
  // se recorta con puntos suspensivos. Si la mesa es pequeña se esconde primero el cliente,
  // luego el icono y la palabra pasa a su forma corta («Pronto», «Tarde»); la palabra se queda.
  const content = (
    <span
      aria-hidden
      className={cn(
        "@container/mesa relative flex size-full min-h-0 flex-col overflow-hidden",
        round ? "items-center justify-center gap-0.5 px-[10%] py-[16%] text-center" : "justify-between px-2 pt-1.5 pb-3",
      )}
    >
      <span className={cn("flex w-full min-w-0 items-baseline gap-1.5", round ? "justify-center" : "justify-between")}>
        <span className={cn("cifra shrink-0 leading-none font-semibold", round ? "text-[13px]" : "text-[14px]")}>{t.name}</span>
        <span className={cn("cifra truncate text-[11px] leading-none text-muted-foreground", round && "hidden @min-[64px]/mesa:inline")}>
          {l?.detail ?? `${t.seats} pl.`}
        </span>
      </span>
      {l && look && StateIcon ? (
        <span className={cn("flex w-full min-w-0 flex-col", round ? "items-center" : "")}>
          <span className={cn("flex max-w-full min-w-0 items-center gap-1 text-[11px] leading-tight font-medium @max-[56px]/mesa:text-[10px] @max-[56px]/mesa:tracking-tight", look.text)}>
            <StateIcon weight="bold" className="size-3 shrink-0 @max-[62px]/mesa:hidden" />
            <span className="truncate @max-[84px]/mesa:hidden">{look.label}</span>
            <span className="hidden truncate @max-[84px]/mesa:inline">{look.short}</span>
          </span>
          {l.guest ? <span className="hidden w-full truncate text-[11.5px] leading-tight text-soft-foreground @min-[60px]/mesa:block">{l.guest}</span> : null}
        </span>
      ) : !t.enabled || t.joinableWith.length > 0 ? (
        <span className="w-full truncate text-[11px] text-muted-foreground">
          {t.enabled ? `+ ${t.joinableWith.map((id) => names.get(id) ?? "?").join(", ")}` : "Deshabilitada"}
        </span>
      ) : null}
      {l && (l.state === "seated" || l.state === "overtime") ? (
        <span className={cn("absolute h-[3px] overflow-hidden rounded-full bg-foreground/10", round ? "inset-x-[28%] bottom-[9%]" : "inset-x-2.5 bottom-1.5")}>
          <span className={cn("block h-full rounded-full", l.state === "overtime" ? "bg-warning" : "bg-success")} style={{ width: `${Math.round(l.progress * 100)}%` }} />
        </span>
      ) : null}
    </span>
  )

  return (
    <li
      key={t.id}
      data-mesa-estado={state ?? "plano"}
      data-elegida={selected || undefined}
      aria-label={clickable ? undefined : description}
      title={clickable ? undefined : description}
      style={box}
      className={cn(
        "group/mesa absolute border shadow-soft transition-[box-shadow,transform,border-color,background-color] duration-200 ease-(--ease-llenamos)",
        round ? "rounded-full" : "rounded-lg",
        look ? look.top : "border-foreground/20 bg-[#1f1c17] hover:border-foreground/40",
        !t.enabled && "border-dashed opacity-55",
        clickable && "hover:-translate-y-px hover:shadow-float",
        selected && "z-10 -translate-y-px shadow-float outline-2 outline-offset-4 outline-foreground/80",
      )}
    >
      {chairs.map((c, i) => (
        <span
          key={i}
          aria-hidden
          style={c.style}
          className={cn(
            "pointer-events-none absolute h-[7px] w-[18px] rounded-[3px] transition-colors duration-200",
            i < occupied ? (look?.chair ?? "bg-foreground/15") : t.enabled ? "bg-foreground/[0.13]" : "bg-foreground/[0.06]",
          )}
        />
      ))}
      {clickable ? (
        <button
          type="button"
          aria-label={description}
          aria-pressed={selected}
          title={description}
          onClick={() => onSelect?.(t.id)}
          className={cn("absolute inset-0 size-full cursor-pointer text-left focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:outline-none", round ? "rounded-full" : "rounded-lg")}
        >
          {content}
        </button>
      ) : (
        content
      )}
    </li>
  )
}

/** Leyenda de los estados en directo (fase 1): color, icono y palabra. */
export function PlanoLeyendaDirecto({ counts }: { counts?: Partial<Record<TableLiveState, number>> }) {
  const items: TableLiveState[] = ["free", "reserved", "soon", "late", "seated", "overtime"]
  return (
    <ul aria-label="Leyenda" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {items.map((state) => {
        const s = ESTADO_MESA[state]
        const I = s.icon
        return (
          <li key={state} className="flex items-center gap-1.5">
            <I aria-hidden weight="bold" className={cn("size-3.5", s.text)} />
            {s.label}
            {counts?.[state] !== undefined ? <span className="cifra text-soft-foreground">{counts[state]}</span> : null}
          </li>
        )
      })}
    </ul>
  )
}

export function PlanoLeyenda() {
  return (
    <ul aria-label="Leyenda" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="size-2.5 rounded-[3px] border border-foreground/25" />
        Rectangular
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="size-2.5 rounded-full border border-foreground/25" />
        Redonda
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="size-2.5 rounded-[3px] border border-dashed border-foreground/25 opacity-60" />
        Deshabilitada
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="cifra text-foreground/70">+ S2</span>
        se une con
      </li>
    </ul>
  )
}
