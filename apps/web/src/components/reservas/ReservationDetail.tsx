"use client"

import {
  can,
  horaLocal,
  MESSAGE_CHANNEL_LABEL,
  MESSAGE_STATUS_LABEL,
  MESSAGE_TEMPLATE_LABEL,
  RESERVATION_STATUS_LABEL,
  type ConfiguracionReservas,
  type ReservationWithId,
} from "@llenamos/core"
import { DotsThreeIcon, PhoneIcon } from "@phosphor-icons/react"
import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import { Notice } from "@/components/common/notice"
import { Tag } from "@/components/common/tag"
import { useHotkeys } from "@/components/panel/command/hotkeys"
import { Keys } from "@/components/panel/command/Keys"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import type { TableDoc } from "@/lib/data/parse"
import { useCustomer, useReservationMessages } from "@/lib/data/reservas"
import { useCloseOnHide } from "@/lib/open-state"
import { actionsFor, seatedMinutes, formatMinutes, tableLabel, visibleStatus, type ReservationAction } from "@/lib/reservas/estados"
import { duration, euros, longDate, prettyPhone, shortDate, timeOf } from "@/lib/reservas/formato"
import { runStatusAction, useMutation } from "@/lib/reservas/hooks"
import { CustomerSheet } from "./CustomerSheet"
import { ReservationStatusDot } from "./Estado"
import { GuestAvatar, GuestBadges, SourceLabel } from "./Huesped"
import { MoveDialog } from "./MoveDialog"
import { StatusConfirmDialog } from "./StatusConfirmDialog"
import { TablesDialog } from "./TablesDialog"

type StatusLike = Extract<ReservationAction, { kind: "status" | "seatAt" }>

/** Detalle de una reserva en un panel a la derecha, con su acción principal abajo. */
export function ReservationDetail({
  reservation,
  open,
  onOpenChange,
  now,
  config,
  tables,
  tableNames,
}: {
  reservation: ReservationWithId | null
  open: boolean
  onOpenChange: (open: boolean) => void
  now: number
  config: ConfiguracionReservas
  tables: readonly TableDoc[]
  tableNames: ReadonlyMap<string, string>
}) {
  useCloseOnHide(() => onOpenChange(false))
  return (
    <Sheet open={open && reservation !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 overflow-y-auto bg-popover shadow-float data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        {reservation ? (
          <DetailBody key={reservation.id} reservation={reservation} now={now} config={config} tables={tables} tableNames={tableNames} />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function DetailBody({
  reservation: r,
  now,
  config,
  tables,
  tableNames,
}: {
  reservation: ReservationWithId
  now: number
  config: ConfiguracionReservas
  tables: readonly TableDoc[]
  tableNames: ReadonlyMap<string, string>
}) {
  const { restaurant, location, role } = usePanel()
  const tz = config.zonaHoraria
  const lid = location?.id ?? ""
  const ctx = { restaurantId: restaurant.id, locationId: lid }
  const customer = useCustomer(restaurant.id, can(role, "clientes.ver") ? r.customerId : null)
  const messages = useReservationMessages(restaurant.id, r.id, can(role, "mensajes.ver"))
  const plan = actionsFor(r, now, tableNames, { canManage: can(role, "reservas.gestionar") })

  const [dialog, setDialog] = useState<"tables" | "move" | "customer" | null>(null)
  const [confirm, setConfirm] = useState<Extract<ReservationAction, { kind: "status" }> | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  useCloseOnHide(() => {
    setDialog(null)
    setConfirm(null)
    setMenuOpen(false)
  })

  const status = useMutation(async (action: StatusLike, reason?: string) => runStatusAction(ctx, r, action, reason))

  async function act(action: ReservationAction) {
    if (action.kind === "tables") return setDialog("tables")
    if (action.kind === "move") return setDialog("move")
    if (action.kind === "status" && action.needsConfirm) return setConfirm(action)
    const ok = await status.run(action)
    if (ok) toast.success(`${r.guestName}: ${successText(action)}`)
  }

  const c = customer.status === "ready" ? customer.data : null
  const busy = status.pending
  const destructive = plan.secondary.filter((a) => a.kind === "status" && a.destructive)
  const others = plan.secondary.filter((a) => !(a.kind === "status" && a.destructive))
  const wall = horaLocal(r.startAt, tz)

  // Ctrl Intro o ⌘ Intro: la acción principal sin ir al ratón (propuesta A).
  useHotkeys({ "mod+enter": () => {
    if (plan.primary && !busy && !dialog && !confirm) void act(plan.primary)
  } })

  return (
    <>
      <SheetHeader className="gap-3 border-b bg-card pb-5">
        <div className="flex items-center justify-between gap-3 pr-8">
          <span className="cifra text-xs text-muted-foreground">Ref. {r.reference}</span>
          <ReservationStatusDot reservation={r} now={now} pill />
        </div>
        <div className="flex items-center gap-3.5">
          <GuestAvatar name={r.guestName} size="lg" ring={r.status === "seated" ? "seated" : visibleStatus(r, now).tone === "late" ? "late" : "none"} />
          <div className="flex min-w-0 flex-col gap-1">
            <SheetTitle className="text-xl leading-tight">{r.guestName}</SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <a href={`tel:${r.phone}`} className="cifra inline-flex items-center gap-1 text-soft-foreground hover:text-foreground">
                <PhoneIcon aria-hidden /> {prettyPhone(r.phone)}
              </a>
              <SourceLabel source={r.source} />
              {r.email ? <span className="truncate">{r.email}</span> : null}
            </SheetDescription>
          </div>
        </div>
        <GuestBadges reservation={r} customer={c} />
      </SheetHeader>

      <div className="flex flex-col gap-6 p-4">
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border bg-border shadow-soft">
          <Datum label="Hora" value={<span className="cifra text-2xl font-medium">{timeOf(r.startAt, tz)}</span>} hint={longDate(wall.fecha)} />
          <Datum label="Personas" value={<span className="cifra text-2xl font-medium">{r.partySize}</span>} />
          <Datum
            label="Mesa"
            value={
              r.tableIds.length > 0 ? (
                <span className="cifra text-2xl font-medium">{tableLabel(r.tableIds, tableNames)}</span>
              ) : (
                <span className="text-lg text-warning">Sin mesa</span>
              )
            }
            hint={r.tableIds.length === 0 && r.suggestedTableIds.length > 0 ? `${tableLabel(r.suggestedTableIds, tableNames)} sugerida` : undefined}
          />
          <Datum
            label={r.status === "seated" ? "Sentados" : "Duración"}
            value={<span className="cifra text-2xl font-medium">{r.status === "seated" ? formatMinutes(seatedMinutes(r, now)) : duration(r.durationMinutes)}</span>}
            hint={r.status === "seated" ? `de ${duration(r.durationMinutes)}` : undefined}
          />
        </dl>

        {r.notes || r.guestNotes ? (
          <section className="flex flex-col gap-3" aria-label="Notas">
            {r.guestNotes ? <Note label="Nota del cliente" text={r.guestNotes} /> : null}
            {r.notes ? <Note label="Nota del equipo" text={r.notes} /> : null}
          </section>
        ) : null}

        {r.deposit.status !== "none" ? (
          <section className="flex flex-col gap-1 text-sm" aria-label="Señal">
            <span className="text-xs text-muted-foreground">Señal</span>
            <span>
              <span className="cifra">{euros(r.deposit.amountCents)}</span> · {DEPOSIT_LABEL[r.deposit.status]}
            </span>
          </section>
        ) : null}

        {can(role, "clientes.ver") ? (
          <section className="flex flex-col gap-2" aria-label="Cliente">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">Cliente</span>
              {c ? (
                <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setDialog("customer")}>
                  Ver ficha
                </Button>
              ) : null}
            </div>
            {customer.status === "loading" ? (
              <span className="text-sm text-muted-foreground">Cargando la ficha…</span>
            ) : c ? (
              <>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                  <span>
                    <span className="cifra">{c.visits}</span> <span className="text-muted-foreground">{c.visits === 1 ? "visita" : "visitas"}</span>
                  </span>
                  <span>
                    <span className="cifra">{c.noShows}</span> <span className="text-muted-foreground">no vino</span>
                  </span>
                  <span>
                    <span className="cifra">{c.cancellations}</span> <span className="text-muted-foreground">canceló</span>
                  </span>
                  <span className="text-muted-foreground">
                    {c.lastVisitAt ? `última, ${shortDate(c.lastVisitAt, tz)}` : "primera visita"}
                  </span>
                </div>
                {c.allergies || c.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {c.allergies ? <Tag tone="alergia">Alergia: {c.allergies}</Tag> : null}
                    {c.tags.map((t) => (
                      <Tag key={t} tone={t.toLowerCase() === "habitual" ? "habitual" : "neutro"}>
                        {t}
                      </Tag>
                    ))}
                  </div>
                ) : null}
                {c.notes ? <p className="text-sm text-soft-foreground">{c.notes}</p> : null}
              </>
            ) : customer.status === "ready" ? (
              <span className="text-sm text-muted-foreground">Cliente nuevo: la ficha se crea al guardar la reserva.</span>
            ) : (
              <span className="text-sm text-muted-foreground">No se ha podido cargar la ficha.</span>
            )}
          </section>
        ) : null}

        {can(role, "mensajes.ver") ? (
          <section className="flex flex-col gap-2" aria-label="Mensajes">
            <span className="text-xs text-muted-foreground">Mensajes</span>
            {messages.status === "ready" && messages.data.length === 0 ? (
              <span className="text-sm text-muted-foreground">Ninguno todavía.</span>
            ) : messages.status === "ready" ? (
              <ol className="flex flex-col gap-2">
                {messages.data.map((m) => (
                  <li key={m.id} className="grid grid-cols-[12px_minmax(0,1fr)] gap-2 text-sm">
                    <span aria-hidden className={`mt-1.5 size-2 rounded-full border-[1.5px] ${MESSAGE_DOT[m.status]}`} />
                    <span className="flex flex-col">
                      <span>
                        {capitalize(MESSAGE_TEMPLATE_LABEL[m.template])} por {MESSAGE_CHANNEL_LABEL[m.channel]}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        <span className="cifra">
                          {shortDate(m.sendAt, tz)} {timeOf(m.sendAt, tz)}
                        </span>{" "}
                        · {MESSAGE_STATUS_LABEL[m.status]}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : messages.status === "loading" ? (
              <span className="text-sm text-muted-foreground">Cargando…</span>
            ) : (
              <span className="text-sm text-muted-foreground">No se han podido cargar los mensajes.</span>
            )}
          </section>
        ) : null}

        <section className="flex flex-col gap-2" aria-label="Historial">
          <span className="text-xs text-muted-foreground">Historial</span>
          <ol className="flex flex-col gap-1.5 text-sm">
            <li className="text-muted-foreground">{SOURCE_TEXT[r.source]}</li>
            {r.history.map((h, i) => (
              <li key={i}>
                <span className="cifra text-muted-foreground">
                  {shortDate(h.at, tz)} {timeOf(h.at, tz)}
                </span>{" "}
                {RESERVATION_STATUS_LABEL[h.from]} → {RESERVATION_STATUS_LABEL[h.to]}
                {h.reason ? <span className="text-muted-foreground"> · {h.reason}</span> : null}
              </li>
            ))}
          </ol>
        </section>

        {status.error ? (
          <Notice tone="error" title="No se ha podido guardar" detail={status.error.code}>
            {status.error.message}
          </Notice>
        ) : null}
      </div>

      {plan.primary || plan.secondary.length > 0 ? (
        <SheetFooter className="sticky bottom-0 mt-auto flex-row flex-wrap gap-2 border-t bg-popover">
          {plan.primary ? (
            <Button size="lg" className="flex-1" disabled={busy} onClick={() => void act(plan.primary!)}>
              {busy ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
              {busy ? "Guardando…" : plan.primary.label}
              {!busy ? (
                <Keys
                  keys={["mod", "enter"]}
                  className="hidden opacity-80 sm:inline-flex [&_kbd]:border-primary-foreground/25 [&_kbd]:bg-primary-foreground/10 [&_kbd]:text-primary-foreground [&_kbd]:shadow-none"
                />
              ) : null}
            </Button>
          ) : null}
          {others.slice(0, 1).map((a) => (
            <Button key={a.label} size="lg" variant="outline" disabled={busy} onClick={() => void act(a)}>
              {a.label}
            </Button>
          ))}
          {others.length > 1 || destructive.length > 0 ? (
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button size="icon-lg" variant="outline" aria-label="Más acciones" disabled={busy}>
                  <DotsThreeIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {others.slice(1).map((a) => (
                  <DropdownMenuItem key={a.label} onSelect={() => void act(a)}>
                    {a.label}
                  </DropdownMenuItem>
                ))}
                {others.length > 1 && destructive.length > 0 ? <DropdownMenuSeparator /> : null}
                {destructive.map((a) => (
                  <DropdownMenuItem key={a.label} variant="destructive" onSelect={() => void act(a)}>
                    {a.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </SheetFooter>
      ) : null}

      <StatusConfirmDialog
        reservation={r}
        action={confirm}
        pending={status.pending}
        error={confirm ? status.error : null}
        onClose={() => {
          status.reset()
          setConfirm(null)
        }}
        onConfirm={async (reason) => {
          if (!confirm) return
          if (await status.run(confirm, reason)) {
            toast.success(`${r.guestName}: ${successText(confirm)}`)
            setConfirm(null)
          }
        }}
      />
      <TablesDialog
        open={dialog === "tables"}
        onOpenChange={(o) => setDialog(o ? "tables" : null)}
        reservation={r}
        restaurantId={restaurant.id}
        locationId={lid}
        tableNames={tableNames}
        timezone={tz}
      />
      {dialog === "move" ? (
        <MoveDialog
          open
          onOpenChange={(o) => setDialog(o ? "move" : null)}
          reservation={r}
          restaurantId={restaurant.id}
          locationId={lid}
          config={config}
          tables={tables}
        />
      ) : null}
      {c ? <CustomerSheet customer={c} open={dialog === "customer"} onOpenChange={(o) => setDialog(o ? "customer" : null)} timezone={tz} /> : null}
    </>
  )
}

function Datum({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="bg-surface-sunken/70 px-3.5 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
      {hint ? <dd className="text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  )
}

function Note({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <p className="text-sm whitespace-pre-line text-soft-foreground">{text}</p>
    </div>
  )
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function successText(a: StatusLike): string {
  if (a.kind === "seatAt") return `sentada en ${a.label.replace(/^Sentar en /, "")}`
  return { pending: "pendiente", confirmed: "confirmada", seated: "sentada", finished: "terminada, mesa libre", cancelled: "cancelada", no_show: "marcada como no presentada" }[a.to]
}

const SOURCE_TEXT = {
  web: "Reservada en la web",
  widget: "Reservada desde el widget de su web",
  phone: "Tomada por teléfono",
  walk_in: "Entró sin reserva",
  import: "Importada de una hoja de cálculo",
  waitlist: "Llegó desde la lista de espera",
} as const

const DEPOSIT_LABEL = {
  none: "no se pide",
  required: "pendiente de pago",
  not_configured: "se pide, pero los pagos no están configurados",
  paid: "pagada",
  refunded: "devuelta",
  failed: "el pago falló",
} as const

const MESSAGE_DOT = {
  queued: "border-muted-foreground bg-transparent",
  sent: "border-success bg-success",
  captured: "border-warning bg-transparent",
  not_configured: "border-warning bg-transparent",
  failed: "border-destructive bg-destructive",
  cancelled: "border-ash bg-ash",
} as const
