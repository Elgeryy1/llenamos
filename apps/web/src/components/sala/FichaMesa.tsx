"use client"

import { can, type ReservationWithId } from "@llenamos/core"
import { ArrowSquareOutIcon, UsersIcon, XIcon } from "@phosphor-icons/react"
import { motion } from "motion/react"
import { toast } from "sonner"
import { Notice } from "@/components/common/notice"
import { usePanel } from "@/components/panel/PanelContext"
import { ReservationStatusDot } from "@/components/reservas/Estado"
import { GuestAvatar, GuestBadges, SourceLabel } from "@/components/reservas/Huesped"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/cn"
import type { TableDoc } from "@/lib/data/parse"
import type { CustomerDoc } from "@/lib/data/reservas"
import { actionsFor, formatMinutes, tableLabel, type ReservationAction } from "@/lib/reservas/estados"
import { duration, timeOf } from "@/lib/reservas/formato"
import { runStatusAction, useMutation } from "@/lib/reservas/hooks"
import type { TableLive } from "@/lib/reservas/sala"
import { ESTADO_MESA } from "./Plano"

type Direct = Extract<ReservationAction, { kind: "status" | "seatAt" }>

/** La acción principal se hace aquí si no pide nada más (sentar, terminar, confirmar). */
function directAction(a: ReservationAction | null): Direct | null {
  if (!a) return null
  if (a.kind === "seatAt") return a
  if (a.kind === "status" && !a.needsConfirm) return a
  return null
}

function doneText(a: Direct): string {
  if (a.kind === "seatAt") return `sentada en ${a.label.replace(/^Sentar en /, "")}`
  return { pending: "pendiente", confirmed: "confirmada", seated: "sentada", finished: "terminada, mesa libre", cancelled: "cancelada", no_show: "marcada como no presentada" }[a.to]
}

/**
 * Ficha de una mesa al lado del plano: estado, quién está o quién llega, cuánto llevan,
 * sus etiquetas y lo que queda hoy en esa mesa. La acción principal se hace desde aquí;
 * el resto (cambiar mesa, mover, cancelar) en el detalle de la reserva.
 */
export function FichaMesa({
  table,
  live,
  names,
  tz,
  now,
  customer,
  onOpenReservation,
  onClose,
}: {
  table: TableDoc
  live: TableLive
  names: ReadonlyMap<string, string>
  tz: string
  now: number
  customer: CustomerDoc | null
  onOpenReservation: (id: string) => void
  onClose: () => void
}) {
  const { restaurant, location, role } = usePanel()
  const look = ESTADO_MESA[live.state]
  const StateIcon = look.icon
  const r = live.current
  const seated = live.state === "seated" || live.state === "overtime"
  const plan = r ? actionsFor(r, now, names, { canManage: can(role, "reservas.gestionar") }) : null
  const direct = directAction(plan?.primary ?? null)
  const ctx = { restaurantId: restaurant.id, locationId: location?.id ?? "" }
  const mutation = useMutation(async (res: ReservationWithId, action: Direct) => runStatusAction(ctx, res, action))
  const later = live.reservations.filter((x) => x.id !== r?.id)

  return (
    <motion.section
      key={table.id}
      aria-label={`Ficha de la mesa ${table.name}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
      className="superficie flex flex-col overflow-hidden"
    >
      <header className="flex items-start gap-3 border-b p-4">
        <span
          aria-hidden
          className={cn("cifra flex size-12 shrink-0 items-center justify-center border text-lg font-semibold shadow-soft", table.shape === "round" ? "rounded-full" : "rounded-lg", look.top)}
        >
          {table.name}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-base font-semibold">Mesa {table.name}</h2>
          <p className="text-xs text-muted-foreground">
            {table.shape === "round" ? "Redonda" : "Rectangular"} · <span className="cifra">{table.seats}</span> {table.seats === 1 ? "plaza" : "plazas"}
            {live.joinedWith.length > 0 ? <> · unida con <span className="cifra">{tableLabel(live.joinedWith, names)}</span></> : null}
          </p>
          <p className={cn("flex items-center gap-1.5 text-sm font-medium", look.text)}>
            <StateIcon aria-hidden weight="bold" className="size-4" />
            {look.label}
            {live.state === "late" && live.minutes > 0 ? <span className="cifra">· {formatMinutes(live.minutes)}</span> : null}
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Cerrar la ficha de la mesa" onClick={onClose} className="-mt-1 -mr-1">
          <XIcon />
        </Button>
      </header>

      {r ? (
        <div className="flex flex-col gap-4 p-4">
          <div className="flex items-start gap-3">
            <GuestAvatar name={r.guestName} size="lg" ring={seated ? "seated" : live.state === "late" ? "late" : "none"} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="flex items-baseline gap-2">
                <span className="truncate text-[17px] font-semibold">{r.guestName}</span>
              </p>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <UsersIcon aria-hidden className="size-3.5" />
                  <span className="cifra text-soft-foreground">{r.partySize}</span> {r.partySize === 1 ? "persona" : "personas"}
                </span>
                <SourceLabel source={r.source} />
                <span className="cifra">Ref. {r.reference}</span>
              </p>
              <GuestBadges reservation={r} customer={customer} />
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border bg-border">
            <div className="bg-surface-sunken/70 px-3 py-2.5">
              <dt className="text-xs text-muted-foreground">{seated ? "Llegaron" : "Reserva"}</dt>
              <dd className="cifra mt-0.5 text-xl font-medium">{timeOf(r.startAt, tz)}</dd>
            </div>
            <div className="bg-surface-sunken/70 px-3 py-2.5">
              <dt className="text-xs text-muted-foreground">{seated ? "Llevan" : "Duración"}</dt>
              <dd className={cn("cifra mt-0.5 text-xl font-medium", live.state === "overtime" && "text-warning")}>
                {seated ? formatMinutes(live.minutes) : duration(r.durationMinutes)}
              </dd>
            </div>
          </dl>

          {seated ? (
            <div className="flex flex-col gap-1.5">
              <Progress
                value={Math.round(live.progress * 100)}
                aria-label="Tiempo de la reserva que llevan sentados"
                className={cn("h-1.5 bg-surface-sunken", live.state === "overtime" ? "[&>[data-slot=progress-indicator]]:bg-warning" : "[&>[data-slot=progress-indicator]]:bg-success")}
              />
              <p className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {live.state === "overtime" ? "Pasan de su hora" : "Tiempo de la reserva"}
                </span>
                <span className="cifra">de {duration(r.durationMinutes)}</span>
              </p>
            </div>
          ) : null}

          {r.guestNotes || r.notes ? (
            <div className="flex flex-col gap-1 rounded-[10px] bg-foreground/[0.04] px-3 py-2.5 text-sm text-soft-foreground">
              {r.guestNotes ? <p>{r.guestNotes}</p> : null}
              {r.notes ? <p className="text-muted-foreground">{r.notes}</p> : null}
            </div>
          ) : null}

          {mutation.error ? (
            <Notice tone="error" title="No se ha podido guardar" detail={mutation.error.code}>
              {mutation.error.message}
            </Notice>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {direct ? (
              <Button
                size="lg"
                className="flex-1 shadow-soft"
                disabled={mutation.pending}
                onClick={async () => {
                  if (await mutation.run(r, direct)) toast.success(`${r.guestName}: ${doneText(direct)}`)
                }}
              >
                {mutation.pending ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
                {mutation.pending ? "Guardando…" : direct.label}
              </Button>
            ) : null}
            <Button size="lg" variant="outline" className={direct ? "" : "flex-1"} onClick={() => onOpenReservation(r.id)}>
              <ArrowSquareOutIcon aria-hidden /> Abrir reserva
            </Button>
          </div>
        </div>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">Nada más hoy en esta mesa.</p>
      )}

      {later.length > 0 ? (
        <div className="flex flex-col gap-2 border-t bg-surface-sunken/40 p-4">
          <h3 className="text-xs text-muted-foreground">Después, en esta mesa</h3>
          <ol className="relative flex flex-col gap-1 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-border">
            {later.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  onClick={() => onOpenReservation(x.id)}
                  aria-label={`Abrir la reserva de ${x.guestName} a las ${timeOf(x.startAt, tz)}`}
                  className="relative flex w-full items-center gap-3 rounded-md py-2 pr-2 pl-5 text-left text-sm transition-colors hover:bg-surface-raised"
                >
                  <span aria-hidden className="absolute top-[15px] left-0.5 size-[7px] rounded-full border border-muted-foreground bg-card" />
                  <span className="cifra w-11 shrink-0 self-start pt-px font-medium">{timeOf(x.startAt, tz)}</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{x.guestName}</span>
                    <span className="block min-w-0 overflow-hidden">
                      <ReservationStatusDot reservation={x} now={now} />
                    </span>
                  </span>
                  <span className="cifra self-start pt-px text-xs text-muted-foreground">{x.partySize} p.</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </motion.section>
  )
}
