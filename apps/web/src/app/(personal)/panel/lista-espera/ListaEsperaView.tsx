"use client"

import { sumarDias, WAITLIST_STATUS_LABEL, type WaitlistSource, type WaitlistStatus } from "@llenamos/core"
import { CaretLeftIcon, CaretRightIcon, ClockCountdownIcon, PhoneIcon, UsersIcon } from "@phosphor-icons/react"
import { useMemo, useState } from "react"
import { SummaryStrip } from "@/components/common/summary-strip"
import { GuestAvatar } from "@/components/reservas/Huesped"
import { DatePicker } from "@/components/common/date-picker"
import { EmptyState } from "@/components/common/empty-state"
import { LiveIndicator, LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { LiveError } from "@/components/panel/LiveError"
import { usePanel } from "@/components/panel/PanelContext"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { RequireReservations } from "@/components/reservas/RequireReservations"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/cn"
import { useReservationSettings, useWaitlist } from "@/lib/data/reservas"
import { localDate } from "@/lib/reservas/dia"
import { dateToFecha, fechaToDate, longDate, prettyPhone, relativeDay, timeOf } from "@/lib/reservas/formato"
import { useNow } from "@/lib/reservas/hooks"

export function ListaEsperaView() {
  return (
    <RequirePermission permission="reservas.ver" what="la lista de espera">
      <RequireReservations>
        <ListaEspera />
      </RequireReservations>
    </RequirePermission>
  )
}

const DOT: Record<WaitlistStatus, string> = {
  waiting: "border-muted-foreground bg-transparent",
  offered: "border-warning bg-warning",
  booked: "border-success bg-success",
  expired: "border-ash bg-ash",
  cancelled: "border-destructive bg-transparent",
}

const SOURCE: Record<WaitlistSource, string> = { web: "web", widget: "widget", staff: "equipo" }

const ORDER: Record<WaitlistStatus, number> = { offered: 0, waiting: 1, booked: 2, expired: 3, cancelled: 4 }

function ListaEspera() {
  const { restaurant, location } = usePanel()
  const tz = restaurant.timezone
  const now = useNow()
  const today = localDate(now, tz)
  const [date, setDate] = useState<string | null>(null)
  const day = date ?? today
  const lid = location?.id ?? null
  const entries = useWaitlist(restaurant.id, lid, day)
  const settings = useReservationSettings(restaurant.id, lid, tz)
  const enabled = settings.status === "ready" ? settings.data.settings.waitlist.enabled : null

  const rows = useMemo(
    () => (entries.status === "ready" ? [...entries.data].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.from.localeCompare(b.from)) : []),
    [entries],
  )
  const waiting = rows.filter((r) => r.status === "waiting")
  const offered = rows.filter((r) => r.status === "offered")
  const booked = rows.filter((r) => r.status === "booked")

  const when = relativeDay(day, today)
  return (
    <>
      <header className="mb-6">
        <p className="mb-1.5 text-[13px] text-muted-foreground sm:text-sm">{capitalize(longDate(day))} · {location?.name ?? ""}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-[32px]">{entries.status === "ready" ? (waiting.length + offered.length > 0 ? `${waiting.length + offered.length} ${waiting.length + offered.length === 1 ? "grupo esperando" : "grupos esperando"} mesa ${when}` : `Nadie esperando ${when}`) : "La próxima mesa, para quien espera"}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Cuando se libera sitio, se ofrece la hora a la primera entrada que encaja. El hueco se guarda mientras decide.</p>
      </header>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-xl border bg-surface-sunken/60 p-1">
          <Button variant="ghost" size="icon-lg" className="pointer-coarse:size-11" aria-label="Día anterior" onClick={() => setDate(sumarDias(day, -1))}><CaretLeftIcon /></Button>
          <DatePicker shortOnMobile className="bg-card shadow-soft" value={fechaToDate(day)} onChange={(d) => setDate(dateToFecha(d))} label="Día de la lista de espera" />
          <Button variant="ghost" size="icon-lg" className="pointer-coarse:size-11" aria-label="Día siguiente" onClick={() => setDate(sumarDias(day, 1))}><CaretRightIcon /></Button>
        </div>
        {day !== today ? <Button variant="outline" size="lg" onClick={() => setDate(null)}>Hoy</Button> : null}
        <LiveIndicator time={timeOf(now, tz)} />
      </div>

      {enabled === false ? (
        <Notice tone="warning" className="mb-6" title="La lista de espera está apagada">
          Los clientes no pueden apuntarse desde la web. Se enciende en Horarios y reservas.
        </Notice>
      ) : null}

      {entries.status === "loading" ? (
        <LoadingBlock label="Cargando la lista de espera…" className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </LoadingBlock>
      ) : entries.status === "error" ? (
        <LiveError title="No se ha podido cargar la lista de espera" error={entries.error} />
      ) : rows.length === 0 ? (
        <EmptyState className="superficie" icon={<ClockCountdownIcon size={22} />} title={`Nadie en la lista de espera ${when}`} description="Quien no encuentra hora en la web puede apuntarse, y aparece aquí." />
      ) : (
        <>
          <SummaryStrip className="mb-6" label="Resumen de la lista de espera" items={[
            { label: "Esperando", value: waiting.length, hint: `${waiting.reduce((n, w) => n + w.partySize, 0)} comensales` },
            { label: "Con oferta", value: offered.length, tone: offered.length ? "warning" : undefined, hint: "pendiente de aceptar" },
            { label: "Ya reservaron", value: booked.length, tone: booked.length ? "success" : undefined },
          ]} />
          <div className="flex flex-col gap-5">
            {(["offered", "waiting", "booked", "expired", "cancelled"] as const).map((status) => {
              const group = rows.filter((w) => w.status === status)
              if (!group.length) return null
              return (
                <section key={status} className="superficie overflow-hidden max-sm:rounded-xl" aria-label={WAITLIST_STATUS_LABEL[status]}>
                  <h2 className="flex items-center gap-2 border-b bg-surface-sunken/40 px-4 py-3 text-sm font-medium sm:px-5">
                    <span aria-hidden className={cn("size-2 rounded-full border-[1.5px]", DOT[status])} />
                    {capitalize(WAITLIST_STATUS_LABEL[status])}
                    <span className="cifra ml-auto text-xs text-muted-foreground">{group.length} {group.length === 1 ? "grupo" : "grupos"}</span>
                  </h2>
                  <ul className="divide-y">
                    {group.map((w) => (
                      <li key={w.id} className={cn("flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-4 sm:px-5", ORDER[w.status] >= 2 && "opacity-60")}>
                        <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1">
                          <GuestAvatar name={w.guestName} ring={w.status === "offered" ? "late" : "none"} className="shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[15px] font-medium break-words">{w.guestName}</p>
                            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><UsersIcon aria-hidden /><span className="cifra text-soft-foreground">{w.partySize}</span> personas · {SOURCE[w.source]}</p>
                          </div>
                        </div>
                        <div className="min-w-0 flex-1 sm:flex-none sm:text-right">
                          <p className="cifra text-[17px] font-medium">{w.from} <span className="font-sans text-xs text-muted-foreground">a</span> {w.to}</p>
                          <p className="text-xs text-muted-foreground">Le va bien esta franja</p>
                        </div>
                        <a href={`tel:${w.phone}`} className="cifra inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs text-soft-foreground hover:bg-surface-raised"><PhoneIcon aria-hidden />{prettyPhone(w.phone)}</a>
                        {w.status === "offered" && w.offer ? (
                          <p className="w-full rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-warning">Mesa a las <span className="cifra">{timeOf(w.offer.startAt, tz)}</span>. Guardada hasta las <span className="cifra">{timeOf(w.offer.expiresAt, tz)}</span>.</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        </>
      )}
    </>
  )
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
