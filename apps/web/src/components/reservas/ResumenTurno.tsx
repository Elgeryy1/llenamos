"use client"

import type { ReservationWithId } from "@llenamos/core"
import { ArrowRightIcon, UsersIcon } from "@phosphor-icons/react"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/cn"
import type { DaySummary } from "@/lib/reservas/dia"
import { tableLabel } from "@/lib/reservas/estados"
import { timeOf } from "@/lib/reservas/formato"
import { GuestAvatar } from "./Huesped"
import { ReservationStatusDot } from "./Estado"

export interface RitmoBar {
  label: string
  covers: number
  startAt: number
  /** Empieza otro turno (se deja un hueco antes). */
  gapBefore?: boolean
}

/**
 * Cabecera del servicio: una sola pieza en tres zonas en vez de cuatro tarjetas iguales.
 * 1) cubiertos con su reparto (sentados, se han ido, por llegar), 2) el ritmo de llegadas
 * por media hora con «ahora» en ámbar, 3) las próximas llegadas, que se abren al pulsar.
 */
export function ResumenTurno({
  summary,
  bars,
  now,
  upcoming,
  upcomingTitle,
  seats,
  tz,
  tableNames,
  onOpen,
}: {
  summary: DaySummary
  bars: RitmoBar[]
  now: number
  upcoming: ReservationWithId[]
  upcomingTitle: string
  /** Plazas de las mesas activas; con ellas se dice cómo de llena está la sala ahora. */
  seats?: number
  tz: string
  tableNames: ReadonlyMap<string, string>
  onOpen: (r: ReservationWithId) => void
}) {
  const total = Math.max(1, summary.covers)
  const parts = [
    { key: "seated", label: "Sentados", value: summary.seated, bar: "bg-success", dot: "bg-success" },
    { key: "finished", label: "Se han ido", value: summary.finished, bar: "bg-ash", dot: "bg-ash" },
    { key: "toArrive", label: "Por llegar", value: summary.toArrive, bar: "bg-foreground/15 bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgb(244_241_234/0.08)_4px_8px)]", dot: "border border-muted-foreground" },
  ]
  return (
    <section aria-label="Resumen del turno" className="superficie grid overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1.15fr)]">
      <div className="flex flex-col gap-3 p-4 sm:gap-4 sm:p-5">
        <p className="text-sm text-muted-foreground max-sm:hidden">Cubiertos</p>
        <p className="flex items-baseline gap-2">
          <span className="cifra text-4xl leading-none font-semibold tracking-tight sm:text-5xl">{summary.covers}</span>
          <span className="text-sm text-muted-foreground">
            <span className="sm:hidden">cubiertos </span>en {summary.reservations} {summary.reservations === 1 ? "reserva" : "reservas"}
          </span>
        </p>
        <div aria-hidden className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-surface-sunken">
          {parts.map((p) =>
            p.value > 0 ? <span key={p.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", p.bar)} style={{ width: `${(p.value / total) * 100}%` }} /> : null,
          )}
        </div>
        <dl className="grid grid-cols-3 gap-2">
          {parts.map((p) => (
            <div key={p.key} className="flex flex-col gap-0.5">
              <dt className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full", p.dot)} />
                {p.label}
              </dt>
              <dd className="cifra text-lg font-medium">{p.value}</dd>
            </div>
          ))}
        </dl>
        {seats ? (
          <div className="mt-auto flex flex-col gap-2 border-t pt-4 max-sm:hidden">
            <p className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">Sala ahora</span>
              <span>
                <span className="cifra font-medium">{Math.min(100, Math.round((summary.seated / seats) * 100))} %</span>{" "}
                <span className="text-xs text-muted-foreground">
                  · <span className="cifra">{summary.seated}</span> de <span className="cifra">{seats}</span> plazas
                </span>
              </span>
            </p>
            <Progress
              value={Math.min(100, (summary.seated / seats) * 100)}
              aria-label="Plazas ocupadas ahora"
              className="h-1.5 bg-surface-sunken [&>[data-slot=progress-indicator]]:bg-success"
            />
          </div>
        ) : null}
      </div>

      <Ritmo bars={bars} now={now} />

      <div className="hidden min-w-0 flex-col gap-3 border-t p-5 sm:flex lg:border-t-0 lg:border-l">
        <p className="text-sm text-muted-foreground">{upcomingTitle}</p>
        {upcoming.length === 0 ? (
          <p className="text-sm text-soft-foreground">Nadie más por llegar en este turno.</p>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {upcoming.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpen(r)}
                  aria-label={`Abrir la reserva de ${r.guestName} a las ${timeOf(r.startAt, tz)}`}
                  className="group flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ease-(--ease-llenamos) hover:bg-surface-raised"
                >
                  <span className="cifra w-12 shrink-0 text-[15px] font-medium">{timeOf(r.startAt, tz)}</span>
                  <GuestAvatar name={r.guestName} size="sm" ring={r.startAt < now ? "late" : "none"} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{r.guestName}</span>
                    <span className="block min-w-0 overflow-hidden">
                      <ReservationStatusDot reservation={r} now={now} />
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <UsersIcon aria-hidden className="size-3.5" />
                      <span className="cifra text-soft-foreground">{r.partySize}</span>
                    </span>
                    <span className={cn("cifra", r.tableIds.length === 0 && "text-warning")}>
                      {r.tableIds.length > 0 ? tableLabel(r.tableIds, tableNames) : "sin mesa"}
                    </span>
                  </span>
                  <ArrowRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** Comensales que llegan en cada media hora; la de ahora en ámbar y las pasadas en ceniza. */
function Ritmo({ bars, now }: { bars: RitmoBar[]; now: number }) {
  const max = Math.max(1, ...bars.map((b) => b.covers))
  const nowIndex = bars.findIndex((b, i) => now >= b.startAt && now < (bars[i + 1] && !bars[i + 1]!.gapBefore ? bars[i + 1]!.startAt : b.startAt + 30 * 60_000))
  const peak = bars.reduce((best, b) => (b.covers > best.covers ? b : best), bars[0] ?? { label: "", covers: 0, startAt: 0 })
  return (
    <figure className="hidden min-w-0 flex-col gap-3 border-t p-5 sm:flex lg:border-t-0 lg:border-l">
      <figcaption className="flex items-baseline justify-between gap-3 text-sm text-muted-foreground">
        <span>Llegadas por media hora</span>
        {peak.covers > 0 ? (
          <span className="text-xs">
            pico a las <span className="cifra text-soft-foreground">{peak.label}</span>
          </span>
        ) : null}
      </figcaption>
      {bars.length === 0 ? (
        <p className="text-sm text-soft-foreground">El local no abre en este turno.</p>
      ) : (
        <ol className="flex h-28 items-end gap-1" aria-label="Comensales que llegan en cada media hora">
          {bars.map((b, i) => {
            const isNow = i === nowIndex
            const past = nowIndex >= 0 ? i < nowIndex : b.startAt < now
            return (
              <li
                key={`${b.label}-${i}`}
                className={cn("relative flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5", b.gapBefore && "ml-3")}
                aria-label={`${b.label}: ${b.covers} comensales${isNow ? ", ahora" : ""}`}
              >
                {b.covers > 0 ? (
                  <span aria-hidden className={cn("cifra text-[10px] leading-none", isNow ? "text-primary" : "text-muted-foreground")}>
                    {b.covers}
                  </span>
                ) : null}
                <span
                  aria-hidden
                  className={cn("w-full rounded-[4px] transition-[height] duration-300 ease-(--ease-llenamos)", isNow ? "bg-primary" : past ? "bg-ash/70" : "bg-foreground/22")}
                  style={{ height: `${Math.max(4, (b.covers / max) * 72)}%` }}
                />
                <span aria-hidden className={cn("cifra text-[10px] leading-none", isNow ? "font-medium text-primary" : "text-muted-foreground", i % 2 === 1 && !isNow && "max-sm:invisible")}>
                  {isNow ? "ahora" : b.label}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </figure>
  )
}
