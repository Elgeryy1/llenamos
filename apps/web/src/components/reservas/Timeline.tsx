"use client"

import { horaLocal, instanteDeHoraLocal, rangoTurno, sumarDias, type ConfiguracionReservas, type ReservationWithId } from "@llenamos/core"
import { useEffect, useMemo, useRef } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/cn"
import type { AreaDoc, TableDoc } from "@/lib/data/parse"
import { isDropped, type ShiftGroup } from "@/lib/reservas/dia"
import { tableLabel, visibleStatus, type StatusTone } from "@/lib/reservas/estados"
import { timeOf } from "@/lib/reservas/formato"
import { planByArea } from "@/lib/sala/plano"
import { TONE_BAR, TONE_BLOCK } from "./tono"

const MIN = 60_000
const HOUR = 60 * MIN
const LABEL_W = 120
const HOUR_W = 136
const ROW_H = 48

interface Range {
  from: number
  to: number
}

/**
 * Instantes que abarca la vista: desde la primera hora en punto antes del primer turno
 * (o de la primera llegada) hasta la hora en punto después de la última salida prevista.
 */
export function timelineRange(groups: readonly ShiftGroup[], config: ConfiguracionReservas, day: string, now?: number): Range | null {
  const tz = config.zonaHoraria
  let from = Infinity
  let to = -Infinity
  for (const g of groups) {
    if (g.shift.index >= 0) {
      const r = rangoTurno({ desde: g.shift.from, ultimaEntrada: g.shift.lastEntry })
      const at = (m: number) => instanteDeHoraLocal(m >= 1440 ? sumarDias(day, 1) : day, m % 1440, tz)
      const a = at(r.desde)
      const b = at(r.ultimaEntrada)
      if (a !== null) from = Math.min(from, a)
      if (b !== null) to = Math.max(to, b + config.duracion.porDefectoMinutos * MIN)
    }
    for (const res of g.reservations) {
      from = Math.min(from, res.startAt)
      to = Math.max(to, blockEnd(res, now ?? res.startAt))
    }
  }
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  const floorHour = (t: number) => t - (horaLocal(t, tz).minutos % 60) * MIN - (t % MIN)
  const start = floorHour(from)
  const endFloor = floorHour(to)
  return { from: start, to: endFloor === to ? to : endFloor + HOUR }
}

type Row =
  | { kind: "area"; id: string; label: string }
  | { kind: "table"; id: string; label: string; seats: number; enabled: boolean; items: ReservationWithId[] }
  | { kind: "lane"; id: string; label: string; items: ReservationWithId[] }

/** Reparte reservas sin mesa en carriles para que no se pisen. */
function lanes(list: ReservationWithId[], now: number): ReservationWithId[][] {
  const out: Array<{ end: number; items: ReservationWithId[] }> = []
  for (const r of [...list].sort((a, b) => a.startAt - b.startAt)) {
    const lane = out.find((l) => l.end <= r.startAt)
    const end = blockEnd(r, now)
    if (lane) {
      lane.items.push(r)
      lane.end = end
    } else out.push({ end, items: [r] })
  }
  return out.map((l) => l.items)
}

/**
 * Línea de tiempo del día: una fila por mesa (por zonas), una columna por hora del turno
 * y cada reserva como un bloque desde su llegada hasta su salida prevista. La línea ámbar
 * es ahora. Arriba, los comensales que llegan en cada media hora. Las reservas que no
 * cumplen el filtro o la búsqueda se quedan apagadas en su sitio, para no perder el plano.
 */
export function Timeline({
  groups,
  config,
  day,
  now,
  areas,
  tables,
  tableNames,
  matches,
  selectedId,
  onOpen,
}: {
  groups: ShiftGroup[]
  config: ConfiguracionReservas
  day: string
  now: number
  areas: readonly AreaDoc[]
  tables: readonly TableDoc[]
  tableNames: ReadonlyMap<string, string>
  matches: (r: ReservationWithId) => boolean
  selectedId: string | null
  onOpen: (r: ReservationWithId) => void
}) {
  const tz = config.zonaHoraria
  const scroller = useRef<HTMLDivElement>(null)
  const range = useMemo(() => timelineRange(groups, config, day, now), [groups, config, day, now])
  const all = useMemo(() => groups.flatMap((g) => g.reservations), [groups])

  const rows = useMemo<Row[]>(() => {
    const shown = all.filter((r) => !isDropped(r.status))
    const out: Row[] = []
    const loose = shown.filter((r) => r.tableIds.length === 0)
    if (loose.length > 0) {
      out.push({ kind: "area", id: "sin-mesa", label: "Sin mesa" })
      lanes(loose, now).forEach((items, i) => out.push({ kind: "lane", id: `carril-${i}`, label: i === 0 ? "Por asignar" : "", items }))
    }
    for (const plan of planByArea(areas, tables)) {
      out.push({ kind: "area", id: plan.area?.id ?? "sin-zona", label: plan.area?.name ?? "Mesas sin zona" })
      for (const t of plan.tables) {
        out.push({ kind: "table", id: t.id, label: t.name, seats: t.seats, enabled: t.enabled, items: shown.filter((r) => r.tableIds.includes(t.id)) })
      }
    }
    return out
  }, [all, areas, tables, now])

  const nowIn = range !== null && now >= range.from && now <= range.to

  // Al abrir, la vista se coloca con «ahora» a un tercio del ancho.
  useEffect(() => {
    const el = scroller.current
    if (!el || !range || !nowIn) return
    const x = ((now - range.from) / HOUR) * HOUR_W
    el.scrollLeft = Math.max(0, x - (el.clientWidth - LABEL_W) / 3)
    // Solo al cambiar de día o de turno, no cada vez que avanza el reloj.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range?.from, range?.to])

  if (!range) return null
  const span = range.to - range.from
  const hours = Math.round(span / HOUR)
  const pct = (t: number) => `${(Math.min(Math.max(t - range.from, 0), span) / span) * 100}%`
  const width = (a: number, b: number) => `${(Math.max(0, Math.min(b, range.to) - Math.max(a, range.from)) / span) * 100}%`

  const ticks = Array.from({ length: hours + 1 }, (_, i) => range.from + i * HOUR)
  const slots = Array.from({ length: hours * 2 }, (_, i) => {
    const start = range.from + i * 30 * MIN
    const covers = all.filter((r) => !isDropped(r.status) && r.startAt >= start && r.startAt < start + 30 * MIN).reduce((n, r) => n + r.partySize, 0)
    return { start, covers }
  })
  const maxCovers = Math.max(1, ...slots.map((s) => s.covers))

  return (
    <figure className="flex flex-col gap-3">
      <div
        ref={scroller}
        className="superficie relative max-h-[calc(100svh-12rem)] min-h-[22rem] overflow-auto overscroll-contain"
        role="region"
        aria-label="Línea de tiempo de las reservas por mesa"
        tabIndex={0}
      >
        <div className="relative" style={{ minWidth: LABEL_W + hours * HOUR_W }}>
          {/* Cabecera: horas y llegadas por media hora. Se queda arriba al bajar. */}
          <div className="sticky top-0 z-30 flex border-b bg-card shadow-[0_1px_0_0_var(--border)]">
            <div className="sticky left-0 z-40 flex shrink-0 flex-col justify-end border-r bg-card px-4 pb-2 text-xs text-muted-foreground" style={{ width: LABEL_W }}>
              <span>Mesa</span>
              <span className="text-[11px]">llegadas</span>
            </div>
            <div className="relative h-16 flex-1">
              {ticks.slice(0, -1).map((t) => (
                <span key={t} className={cn("cifra absolute top-2 pl-1.5 text-xs text-muted-foreground", nowIn && Math.abs(t - now) < 25 * MIN && "invisible")} style={{ left: pct(t) }}>
                  {timeOf(t, tz)}
                </span>
              ))}
              <ol aria-label="Comensales que llegan cada media hora" className="absolute inset-x-0 bottom-1.5 flex h-8 items-end">
                {slots.map((s) => (
                  <li
                    key={s.start}
                    aria-label={`${timeOf(s.start, tz)}: ${s.covers} comensales`}
                    className="flex h-full flex-1 flex-col items-center justify-end gap-px px-[3px]"
                  >
                    {s.covers > 0 ? <span className="cifra text-[9px] leading-none text-muted-foreground">{s.covers}</span> : null}
                    <span
                      aria-hidden
                      className={cn("w-full rounded-[3px]", s.start + 30 * MIN <= now ? "bg-ash/60" : s.start <= now ? "bg-primary" : "bg-foreground/22")}
                      style={{ height: s.covers > 0 ? `${Math.max(8, (s.covers / maxCovers) * 60)}%` : 1 }}
                    />
                  </li>
                ))}
              </ol>
              {nowIn ? (
                <span
                  className="cifra absolute top-1.5 z-10 -translate-x-1/2 rounded-[5px] bg-primary px-1.5 py-px text-xs font-medium text-primary-foreground shadow-soft"
                  style={{ left: pct(now) }}
                >
                  {timeOf(now, tz)}
                </span>
              ) : null}
            </div>
          </div>

          {/* Rejilla de horas y la línea de ahora, por detrás de las filas. */}
          <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-0" style={{ left: LABEL_W }}>
            {ticks.map((t, i) => (
              <span key={t} className={cn("absolute inset-y-0 w-px", i === 0 ? "bg-transparent" : "bg-border")} style={{ left: pct(t) }} />
            ))}
            {ticks.slice(0, -1).map((t) => (
              <span key={`m${t}`} className="absolute inset-y-0 w-px bg-border/40" style={{ left: pct(t + 30 * MIN) }} />
            ))}
          </div>

          <ul className="relative z-10">
            {rows.map((row) =>
              row.kind === "area" ? (
                <li key={`a-${row.id}`} className="flex h-8 border-b bg-surface-sunken/70">
                  <span
                    className="sticky left-0 z-20 flex shrink-0 items-center border-r bg-surface-sunken px-4 text-xs font-medium text-soft-foreground"
                    style={{ width: LABEL_W }}
                  >
                    {row.label}
                  </span>
                </li>
              ) : (
                <li
                  key={`${row.kind}-${row.id}`}
                  className="group/row flex border-b last:border-b-0 hover:bg-foreground/[0.025]"
                  style={{ height: ROW_H * Math.max(1, row.kind === "table" ? lanes(row.items, now).length : 1) }}
                >
                  <span
                    className={cn("sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r bg-card px-4 text-sm", row.kind === "table" && !row.enabled && "text-muted-foreground")}
                    style={{ width: LABEL_W }}
                  >
                    {row.kind === "table" ? (
                      <>
                        <span className="cifra font-medium">{row.label}</span>
                        <span className="cifra text-xs text-muted-foreground">{row.seats} pl.</span>
                      </>
                    ) : (
                      <span className="text-xs text-warning">{row.label}</span>
                    )}
                  </span>
                  <span className="relative flex-1">
                    {(row.kind === "table" ? lanes(row.items, now) : [row.items]).flatMap((lane, i) =>
                      lane.map((r) => (
                      <Block
                        key={r.id}
                        top={i * ROW_H}
                        r={r}
                        now={now}
                        tz={tz}
                        tableNames={tableNames}
                        left={pct(r.startAt)}
                        width={width(r.startAt, blockEnd(r, now))}
                        dim={!matches(r)}
                        selected={selectedId === r.id}
                        onOpen={onOpen}
                      />
                      )),
                    )}
                  </span>
                </li>
              ),
            )}
          </ul>

          {nowIn ? (
            <span aria-hidden className="pointer-events-none absolute top-16 bottom-0 z-[15] w-0.5 -translate-x-px rounded-full bg-primary" style={{ left: `calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${(now - range.from) / span})` }} />
          ) : null}
        </div>
      </div>
      <Legend />
    </figure>
  )
}

/** Los sentados que pasan de su hora se alargan hasta ahora. */
function blockEnd(r: ReservationWithId, now: number): number {
  const end = r.startAt + r.durationMinutes * MIN
  return r.status === "seated" ? Math.max(end, now) : end
}

function Block({
  r,
  top,
  now,
  tz,
  tableNames,
  left,
  width,
  dim,
  selected,
  onOpen,
}: {
  r: ReservationWithId
  top: number
  now: number
  tz: string
  tableNames: ReadonlyMap<string, string>
  left: string
  width: string
  dim: boolean
  selected: boolean
  onOpen: (r: ReservationWithId) => void
}) {
  const v = visibleStatus(r, now)
  const overtime = r.status === "seated" && now > r.startAt + r.durationMinutes * MIN
  const from = timeOf(r.startAt, tz)
  const to = timeOf(r.startAt + r.durationMinutes * MIN, tz)
  const mesa = r.tableIds.length > 0 ? `mesa ${tableLabel(r.tableIds, tableNames)}` : "sin mesa"
  const label = `${r.guestName}, ${r.partySize} ${r.partySize === 1 ? "persona" : "personas"}, de ${from} a ${to}, ${mesa}, ${v.label}${overtime ? ", pasan de su hora" : ""}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Abrir la reserva de ${label}`}
          onClick={() => onOpen(r)}
          className={cn(
            "absolute flex h-10 min-w-6 items-center gap-1.5 overflow-hidden rounded-md border pr-2 pl-3 text-left text-[13px] shadow-soft transition-[opacity,border-color,transform,box-shadow] duration-150 ease-(--ease-llenamos) hover:-translate-y-px hover:shadow-float",
            TONE_BLOCK[v.tone],
            overtime && "border-warning/60",
            dim && "opacity-25",
            selected && "z-10 -translate-y-px shadow-float outline-2 outline-offset-2 outline-foreground/80",
          )}
          style={{ left, width, top: top + 4 }}
        >
          <span aria-hidden className={cn("absolute inset-y-1 left-1 w-[3px] rounded-full", TONE_BAR[v.tone as StatusTone], overtime && "bg-warning")} />
          <span className="truncate font-medium">{r.guestName}</span>
          <span className="cifra shrink-0 text-xs text-muted-foreground">{r.partySize}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex flex-col items-start gap-0.5">
        <span className="font-medium">{r.guestName}</span>
        <span className="cifra">
          {from} a {to} · {r.partySize} pers. · {r.tableIds.length > 0 ? tableLabel(r.tableIds, tableNames) : "sin mesa"}
        </span>
        <span>
          {v.label.charAt(0).toUpperCase() + v.label.slice(1)}
          {overtime ? ", pasan de su hora" : ""}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

function Legend() {
  const items: Array<[StatusTone, string]> = [
    ["waiting", "Por llegar"],
    ["pending", "Sin confirmar"],
    ["late", "Retraso"],
    ["seated", "Sentada"],
    ["finished", "Terminada"],
  ]
  return (
    <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
      {items.map(([tone, text]) => (
        <span key={tone} className="flex items-center gap-1.5">
          <span aria-hidden className={cn("h-3 w-[3px] rounded-full", TONE_BAR[tone])} />
          {text}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-3 w-0.5 rounded-full bg-primary" />
        Ahora
      </span>
      <span className="ml-auto hidden sm:inline">Pasa por encima de un bloque para ver el detalle; pulsa para abrirlo.</span>
    </figcaption>
  )
}
