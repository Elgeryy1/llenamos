"use client"

import { COURSE_LABEL, lineDelay, type StationTicket, type TicketLine } from "@llenamos/core"
import { useRef, useState } from "react"
import { imprimirTicket } from "@/lib/cocina/imprimir"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"

export type Preparacion = "fired" | "preparing" | "ready"
const ESTADO = { held: "Espera a sala", fired: "Por empezar", preparing: "Preparando", ready: "Listo para recoger" } as const

export function Ticket({ ticket, now, pickupMinutes, timezone, disabled, onChange, onBatch }: {
  ticket: StationTicket
  now: number
  pickupMinutes: number
  timezone: string
  disabled: boolean
  onBatch?: (lineIds: string[], status: "preparing" | "ready") => void
  onChange: (line: TicketLine, status: Preparacion) => void
}) {
  const article = useRef<HTMLElement>(null)
  const [selected, setSelected] = useState<string[]>([])
  const selectable = ticket.lines.filter(l => l.status === "fired" || l.status === "preparing")
  const chosen = selectable.filter(l => selected.includes(l.id))
  const start = chosen.filter(l => l.status === "fired")
  const details = ticket.ticket
  const late = ticket.delay?.level === "late"
  const time = (at: number) => new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(at)
  return (
    <article ref={article} aria-label={`Comanda ${ticket.label}`} className={cn("superficie overflow-hidden", late && "border-warning/70")}>
      <header className={cn("flex items-start justify-between gap-3 border-b px-4 py-3", late && "bg-warning/[0.08]")}>
        <div className="min-w-0">
          <h2 className="cifra break-words text-2xl font-semibold">{details?.pickupAt ? "Para llevar" : ticket.label}</h2>
          <p className="mt-1 text-base text-soft-foreground"><span className="cifra">#{details?.reference ?? ticket.orderId.slice(0, 6).toUpperCase()}</span> · {details ? ({ staff: "Camarero", table: "QR", takeaway_web: "Web para llevar" }[details.source]) : "Origen sin registrar"}</p>
          <p className="mt-1 text-base text-muted-foreground">Pedido a las {time(ticket.placedAt)}</p>
        </div>
        <div className={cn("shrink-0 text-right", late ? "text-warning" : "text-soft-foreground")}>
          <p className="cifra text-2xl font-semibold">{ticket.delay ? `${ticket.delay.elapsedMinutes} min` : "En espera"}</p>
          <p className="mt-1 text-sm">{late ? `Retraso ${ticket.delay!.lateByMinutes} min` : ticket.status === "ready" ? "En el pase" : ticket.status === "held" ? "Sin marchar" : "En marcha"}</p>
        </div>
      </header>
      {details?.pickupAt ? <p className="border-b px-4 py-3 text-xl font-semibold">Recogida <span className="cifra">{time(details.pickupAt)}</span> · {details.pickupReference} · {details.guestName}</p> : null}
      {details?.note ? <p className="border-b border-warning/40 bg-warning/[0.08] px-4 py-3 text-xl font-semibold whitespace-pre-wrap">Nota del pedido: {details.note}</p> : null}
      <div data-ticket-controls className="flex flex-wrap gap-2 border-b px-4 py-2">
        <Button variant="ghost" className="h-12 text-base" onClick={() => article.current && imprimirTicket(article.current)}>Imprimir ticket</Button>
        {onBatch && selectable.length ? <>
          <Button variant="outline" className="h-12 text-base" disabled={disabled} onClick={() => setSelected(chosen.length === selectable.length ? [] : selectable.map(l => l.id))} aria-label={chosen.length === selectable.length ? "Quitar selección" : "Seleccionar pendientes"}>{chosen.length === selectable.length ? "Ninguno" : "Todo"}</Button>
          {chosen.length ? <><Button variant="outline" className="h-12 text-base" disabled={disabled || !start.length} onClick={() => onBatch(start.map(l => l.id), "preparing")}>Empezar {start.length || "selección"}</Button>
          <Button variant="outline" className="h-12 text-base text-success" disabled={disabled || !chosen.length} onClick={() => onBatch(chosen.map(l => l.id), "ready")}>Dejar listos {chosen.length || "selección"}</Button></> : null}
        </> : null}
      </div>
      {ticket.status === "held" ? <p className="border-b px-4 py-3 text-lg text-soft-foreground">{ticket.takeawayId ? "Espera a la hora de marcha prevista." : "Espera a sala. Hay una tarea para marchar estos pases."} Todavía no se está cocinando.</p> : null}
      {ticket.courses.map((group) => (
        <section key={group.course} aria-label={COURSE_LABEL.es[group.course]}>
          <h3 className="border-b bg-surface-sunken/60 px-4 py-2 text-base font-semibold">{COURSE_LABEL.es[group.course]}</h3>
          <ul className="divide-y">
            {group.lines.map((line) => {
              const delay = lineDelay(line, now, pickupMinutes)
              const status = line.status as keyof typeof ESTADO
              return (
                <li key={line.id} className="px-4 py-3">
                  {onBatch && (line.status === "fired" || line.status === "preparing") ? <label data-ticket-controls className="float-left mr-3 flex min-h-12 items-center text-base"><input type="checkbox" className="size-5 accent-primary" disabled={disabled} checked={selected.includes(line.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, line.id] : selected.filter(id => id !== line.id))} /><span className="sr-only">Seleccionar {line.name.es}</span></label> : null}
                  <p className="text-2xl leading-snug font-semibold"><span className="cifra mr-2">{line.quantity} ×</span>{line.name.es}</p>
                  {line.variant ? <p className="mt-1 text-base text-soft-foreground">{line.variant.name.es}</p> : null}
                  {line.modifiers.length ? <p className="mt-1 text-base text-soft-foreground">{line.modifiers.map((m) => m.name.es).join(", ")}</p> : null}
                  {line.guest !== null ? <p className="mt-1 text-sm text-muted-foreground">Comensal {line.guest}</p> : null}
                  {line.notes ? <p className="mt-3 border-l-2 border-soft-foreground/40 pl-3 text-lg font-medium whitespace-pre-wrap">{line.notes}</p> : null}
                  <div className="mt-3 flex flex-wrap justify-between gap-2 text-sm">
                    <span className={line.status === "ready" ? "text-success" : "text-muted-foreground"}>{ESTADO[status]}</span>
                    {delay ? <span className={cn("cifra", delay.level === "late" && "text-warning")}>{line.status === "ready" ? "En el pase" : "Preparación"}: {delay.elapsedMinutes} min · objetivo {line.status === "ready" ? pickupMinutes : line.targetMinutes} min</span> : null}
                    {line.status === "held" && line.fireAt !== null ? <span>Marcha prevista {time(line.fireAt)}</span> : null}
                  </div>
                  {line.status === "held" ? null : (
                    <div data-ticket-controls className="mt-3 flex flex-wrap gap-2">
                      {line.status === "fired" ? <Button variant="outline" className="h-12 flex-1 text-base" disabled={disabled} onClick={() => onChange(line, "preparing")}>Empezar</Button> : null}
                      {line.status === "preparing" || line.status === "fired" ? <Button variant="outline" className="h-12 flex-1 border-success/40 text-base text-success" disabled={disabled} onClick={() => onChange(line, "ready")}>Listo</Button> : null}
                      {line.status === "preparing" ? <Button variant="ghost" className="h-12 text-base" disabled={disabled} onClick={() => onChange(line, "fired")}>Deshacer inicio</Button> : null}
                      {line.status === "ready" ? <Button variant="outline" className="h-12 w-full text-base" disabled={disabled} onClick={() => onChange(line, "preparing")}>Volver a preparar</Button> : null}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </article>
  )
}
