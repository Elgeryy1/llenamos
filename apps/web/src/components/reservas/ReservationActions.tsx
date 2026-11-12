"use client"

import { can, type ConfiguracionReservas, type ReservationWithId } from "@llenamos/core"
import { DotsThreeIcon } from "@phosphor-icons/react"
import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/cn"
import type { TableDoc } from "@/lib/data/parse"
import { useCloseOnHide } from "@/lib/open-state"
import { actionsFor, type ActionPlan, type ReservationAction } from "@/lib/reservas/estados"
import { runStatusAction, useMutation } from "@/lib/reservas/hooks"
import { MoveDialog } from "./MoveDialog"
import { StatusConfirmDialog } from "./StatusConfirmDialog"
import { TablesDialog } from "./TablesDialog"

type StatusLike = Extract<ReservationAction, { kind: "status" | "seatAt" }>
type StatusAction = Extract<ReservationAction, { kind: "status" }>

/**
 * De la propuesta C. Lo que se puede hacer con una reserva (sentar, terminar, cambiar mesa, mover, cancelar…)
 * desde cualquier sitio del panel: la fila de la lista, la barra de la reserva elegida y el
 * detalle. Las acciones son las de `actionsFor` (las mismas que acepta el servidor); aquí solo
 * se ejecutan y se abren sus diálogos. Una sola instancia por pantalla vale para todas las filas.
 */
export function useReservationActions({
  reservations,
  config,
  tables,
  tableNames,
}: {
  reservations: readonly ReservationWithId[]
  config: ConfiguracionReservas
  tables: readonly TableDoc[]
  tableNames: ReadonlyMap<string, string>
}) {
  const { restaurant, location, role } = usePanel()
  const lid = location?.id ?? ""
  const ctx = { restaurantId: restaurant.id, locationId: lid }
  const canManage = can(role, "reservas.gestionar")

  const [dialog, setDialog] = useState<{ id: string; kind: "tables" | "move" } | null>(null)
  const [confirm, setConfirm] = useState<{ id: string; action: StatusAction } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  useCloseOnHide(() => {
    setDialog(null)
    setConfirm(null)
  })

  const status = useMutation(async (r: ReservationWithId, action: StatusLike, reason?: string) => runStatusAction(ctx, r, action, reason))
  const find = (id: string | undefined) => (id ? (reservations.find((r) => r.id === id) ?? null) : null)

  async function act(r: ReservationWithId, action: ReservationAction) {
    if (action.kind === "tables" || action.kind === "move") return setDialog({ id: r.id, kind: action.kind })
    if (action.kind === "status" && action.needsConfirm) return setConfirm({ id: r.id, action })
    setBusyId(r.id)
    const ok = await status.run(r, action)
    setBusyId(null)
    if (ok) toast.success(`${r.guestName}: ${successText(action)}`)
  }

  const planFor = (r: ReservationWithId, now: number): ActionPlan => actionsFor(r, now, tableNames, { canManage })

  const confirmFor = find(confirm?.id)
  const dialogFor = find(dialog?.id)
  const dialogs: ReactNode = (
    <>
      {confirmFor ? (
        <StatusConfirmDialog
          reservation={confirmFor}
          action={confirm?.action ?? null}
          pending={status.pending}
          error={status.error}
          onClose={() => {
            status.reset()
            setConfirm(null)
          }}
          onConfirm={async (reason) => {
            if (!confirm) return
            if (await status.run(confirmFor, confirm.action, reason)) {
              toast.success(`${confirmFor.guestName}: ${successText(confirm.action)}`)
              setConfirm(null)
            }
          }}
        />
      ) : null}
      {dialogFor && dialog?.kind === "tables" ? (
        <TablesDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          reservation={dialogFor}
          restaurantId={restaurant.id}
          locationId={lid}
          tableNames={tableNames}
          timezone={config.zonaHoraria}
        />
      ) : null}
      {dialogFor && dialog?.kind === "move" ? (
        <MoveDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          reservation={dialogFor}
          restaurantId={restaurant.id}
          locationId={lid}
          config={config}
          tables={tables}
        />
      ) : null}
    </>
  )

  return {
    act,
    planFor,
    canManage,
    /** Reserva cuya acción se está guardando ahora. */
    busyId: status.pending ? busyId : null,
    /** Error de la última acción sin diálogo (el de cancelar se ve dentro de su diálogo). */
    error: confirm ? null : status.error,
    resetError: status.reset,
    dialogs,
  }
}

export type ReservationActionsApi = ReturnType<typeof useReservationActions>

/**
 * Texto del botón tal como se lee en el mostrador. Una no presentada que se sienta es
 * que «llegó tarde».
 */
export function actionText(r: Pick<ReservationWithId, "status">, a: ReservationAction): string {
  if (r.status === "no_show" && (a.kind === "seatAt" || (a.kind === "status" && a.to === "seated"))) {
    return `Llegó tarde: ${a.label.charAt(0).toLowerCase()}${a.label.slice(1)}`
  }
  return a.label
}

export function successText(a: StatusLike): string {
  if (a.kind === "seatAt") return `sentada en ${a.label.replace(/^Sentar en /, "")}`
  return { pending: "pendiente", confirmed: "confirmada", seated: "sentada", finished: "terminada, mesa libre", cancelled: "cancelada", no_show: "marcada como no presentada" }[a.to]
}

/**
 * Botonera de una reserva: la acción principal en ámbar, una secundaria a la vista y el
 * resto (con cancelar y «no se ha presentado» al final, en rojo) en «Más acciones».
 * `size="xl"` da botones de 48 px para el mostrador.
 */
export function ReservationActionButtons({
  reservation: r,
  plan,
  api,
  size = "lg",
  visible = 1,
  className,
  extra,
  destructiveVisible = false,
}: {
  reservation: ReservationWithId
  plan: ActionPlan
  api: Pick<ReservationActionsApi, "act" | "busyId">
  size?: "lg" | "xl"
  /** Cuántas secundarias se ven fuera del menú. */
  visible?: number
  className?: string
  /** Algo más al final (por ejemplo «Ver detalle»). */
  extra?: ReactNode
  /** Cancelar y «no se ha presentado» a la vista (en el mostrador), no dentro del menú. */
  destructiveVisible?: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  useCloseOnHide(() => setMenuOpen(false))
  const busy = api.busyId === r.id
  const allDestructive = plan.secondary.filter((a) => a.kind === "status" && a.destructive)
  // En el mostrador, cancelar y «no vino» van a la vista; si no, al final del menú.
  const destructive = destructiveVisible ? [] : allDestructive
  const others = plan.secondary.filter((a) => !(a.kind === "status" && a.destructive))
  const shown = others.slice(0, visible)
  const hidden = others.slice(visible)
  const btn = size === "xl" ? "h-12 rounded-[10px] px-4 text-[15px]" : "h-10 px-3.5"
  if (!plan.primary && plan.secondary.length === 0 && !extra) return null

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {plan.primary ? (
        <Button className={cn(btn, "min-w-[9rem] flex-1 font-semibold shadow-soft pointer-coarse:min-w-[9rem]")} disabled={busy} onClick={() => void api.act(r, plan.primary!)}>
          {busy ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
          <span className="truncate">{busy ? "Guardando…" : actionText(r, plan.primary)}</span>
        </Button>
      ) : null}
      {shown.map((a) => (
        <Button key={a.label} variant="outline" className={cn(btn, "bg-card shadow-soft")} disabled={busy} onClick={() => void api.act(r, a)}>
          {actionText(r, a)}
        </Button>
      ))}
      {destructiveVisible
        ? allDestructive.map((a) => (
            <Button
              key={a.label}
              variant="destructive"
              className={btn}
              aria-label={`${a.label}: ${r.guestName}`}
              disabled={busy}
              onClick={() => void api.act(r, a)}
            >
              {/* Texto corto en la barra; el nombre accesible y el menú llevan el completo. */}
              {a.label === "Cancelar reserva" ? "Cancelar" : a.kind === "status" && a.to === "no_show" ? "No vino" : a.label}
            </Button>
          ))
        : null}
      {extra}
      {hidden.length > 0 || destructive.length > 0 ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              // Si en pantalla ancha todo lo del menú ya está a la vista, el menú sobra.
              className={cn(btn, "aspect-square bg-card px-0 shadow-soft")}
              aria-label="Más acciones"
              disabled={busy}
            >
              <DotsThreeIcon weight="bold" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {hidden.map((a) => (
              <DropdownMenuItem key={a.label} className="h-10" onSelect={() => void api.act(r, a)}>
                {actionText(r, a)}
              </DropdownMenuItem>
            ))}
            {hidden.length > 0 && destructive.length > 0 ? <DropdownMenuSeparator /> : null}
            {destructive.map((a) => (
              <DropdownMenuItem
                key={a.label}
                className="h-10"
                variant="destructive"
                onSelect={() => void api.act(r, a)}
              >
                {a.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}
