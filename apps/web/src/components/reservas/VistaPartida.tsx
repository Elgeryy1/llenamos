"use client"

/**
 * Vista partida de la propuesta C, con el aspecto de la sala cálida de B: en la tableta
 * apaisada y más ancho, la lista del turno a la izquierda y el plano a la derecha. Tocar
 * una reserva resalta su mesa y cambia a su zona; tocar una mesa elige su reserva y la trae
 * a la vista en la lista. Debajo del plano, la barra de la reserva elegida con las acciones
 * de mostrador en botones de 48 px. Solo presentación: las acciones son las de
 * `actionsFor` y `runStatusAction`, a través de `useReservationActions`.
 */
import type { ReservationWithId } from "@llenamos/core"
import { CaretRightIcon, HandTapIcon, UsersIcon, XIcon } from "@phosphor-icons/react"
import { useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { SegmentedControl } from "@/components/common/segmented-control"
import { Plano, PlanoLeyendaDirecto, type PlanoLiveTable } from "@/components/sala/Plano"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/cn"
import type { AreaDoc, TableDoc } from "@/lib/data/parse"
import { tableLabel } from "@/lib/reservas/estados"
import { timeOf } from "@/lib/reservas/formato"
import type { TableLive } from "@/lib/reservas/sala"
import { planByArea, type AreaPlan } from "@/lib/sala/plano"
import { ReservationStatusDot } from "./Estado"
import { GuestAvatar } from "./Huesped"
import { rowDomId } from "./ListaDia"
import { ReservationActionButtons, type ReservationActionsApi } from "./ReservationActions"

/* Ancho de la vista partida ---------------------------------------------- */

/** A partir de aquí caben la lista y el plano a la vez (tableta apaisada y escritorio). */
export const SPLIT_QUERY = "(min-width: 1024px)"

function subscribeSplit(onChange: () => void) {
  const mql = window.matchMedia(SPLIT_QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

export function useIsSplit(): boolean {
  return useSyncExternalStore(subscribeSplit, () => window.matchMedia(SPLIT_QUERY).matches, () => false)
}

/* Selección: reserva ↔ mesa ----------------------------------------------- */

/** La reserva que manda en una mesa: la sentada o la siguiente que llega. */
export function reservationForTable(tableId: string, byTable: ReadonlyMap<string, Pick<TableLive, "current">> | null): ReservationWithId | null {
  return byTable?.get(tableId)?.current ?? null
}

/** La zona donde está la primera mesa de la reserva elegida, si la hay. */
export function zoneOfTables(plans: readonly AreaPlan[], tableIds: readonly string[]): AreaPlan | undefined {
  if (tableIds.length === 0) return undefined
  return plans.find((p) => p.tables.some((t) => tableIds.includes(t.id)))
}

/**
 * Lo que pasa al tocar en la vista partida. En la lista: el primer toque elige la reserva
 * (su mesa se resalta en el plano) y el segundo abre su detalle. En el plano: tocar una
 * mesa elige su reserva y trae su fila a la vista. Sin vista partida (móvil), tocar abre el
 * detalle directamente.
 */
export function usePartida({
  split,
  reservations,
  byTable,
  onOpenDetail,
  onReveal,
}: {
  split: boolean
  reservations: readonly ReservationWithId[]
  byTable: ReadonlyMap<string, Pick<TableLive, "current">> | null
  onOpenDetail: (r: ReservationWithId) => void
  /** Permite mostrar la fila si el turno o los filtros la ocultaban. */
  onReveal?: (r: ReservationWithId) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reveal, setReveal] = useState<{ id: string } | null>(null)
  const selected = reservations.find((r) => r.id === selectedId) ?? null

  useLayoutEffect(() => {
    if (!reveal) return
    // Después del render: la fila ya existe aunque hubiese que quitar un filtro.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    document.getElementById(rowDomId(reveal.id))?.scrollIntoView?.({ block: "center", behavior: reduced ? "instant" : "smooth" })
  }, [reveal])

  function selectRow(r: ReservationWithId) {
    if (!split) return onOpenDetail(r)
    if (selectedId === r.id) return onOpenDetail(r)
    setSelectedId(r.id)
  }

  function selectTable(tableId: string) {
    const r = reservationForTable(tableId, byTable)
    if (!r) return
    if (!split) return onOpenDetail(r)
    onReveal?.(r)
    setSelectedId(r.id)
    setReveal({ id: r.id })
  }

  return { selected, selectedId: selected ? selectedId : null, selectRow, selectTable, clear: () => setSelectedId(null), setSelectedId }
}

/* Plano con zonas ----------------------------------------------------------- */

const SIN_ZONA = "sin-zona"
const planKey = (p: AreaPlan) => p.area?.id ?? SIN_ZONA

/**
 * El plano de B en una superficie, con su selector de zona y la leyenda. Si se elige una
 * reserva en la lista, pasa solo a la zona de su mesa y la resalta. Abajo, `footer` (la
 * barra de la reserva elegida).
 */
export function PlanoReservas({
  areas,
  tables,
  names,
  live,
  selectedTableIds,
  onSelectTable,
  footer,
  className,
}: {
  areas: readonly AreaDoc[]
  tables: readonly TableDoc[]
  names: ReadonlyMap<string, string>
  live?: ReadonlyMap<string, PlanoLiveTable>
  selectedTableIds: readonly string[]
  onSelectTable?: (tableId: string) => void
  footer?: ReactNode
  className?: string
}) {
  const plans = planByArea(areas, tables)
  const selKey = selectedTableIds.join(",")
  // La zona elegida a mano vale mientras no cambie la reserva elegida.
  const [pick, setPick] = useState<{ zone: string; forSelection: string } | null>(null)
  const zoneOfSelected = zoneOfTables(plans, selectedTableIds)
  const zone = pick && pick.forSelection === selKey ? pick.zone : zoneOfSelected ? planKey(zoneOfSelected) : (pick?.zone ?? null)
  const current = plans.find((p) => planKey(p) === zone) ?? plans[0]
  const label = current?.area?.name ?? "Mesas sin zona"

  return (
    <section aria-label={`Plano de la zona ${label}`} className={cn("superficie flex min-w-0 flex-col overflow-hidden", className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
        {plans.length > 1 && current ? (
          <SegmentedControl
            label="Zona"
            value={planKey(current)}
            onValueChange={(z) => setPick({ zone: z, forSelection: selKey })}
            options={plans.map((p) => ({ value: planKey(p), label: p.area?.name ?? "Sin zona" }))}
          />
        ) : (
          <h2 className="text-base font-semibold">{label}</h2>
        )}
        <span className="ml-auto text-xs text-muted-foreground">toca una mesa para elegir su reserva</span>
      </div>
      <div className="p-3">
        {!current || current.tables.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Esta zona aún no tiene mesas.</p>
        ) : (
          <Plano label={label} tables={current.tables} names={names} live={live} onSelect={onSelectTable} selectedIds={selectedTableIds} compact />
        )}
      </div>
      {live ? (
        <div className="px-4 pb-3">
          <PlanoLeyendaDirecto />
        </div>
      ) : null}
      {footer}
    </section>
  )
}

/* Barra de la reserva elegida ---------------------------------------------- */

/**
 * Debajo del plano: la reserva elegida y sus acciones de mostrador a la vista, en botones
 * de 48 px (sentar o «llegó tarde: sentar», cambiar mesa, cancelar y no vino), y el acceso
 * a su detalle.
 */
export function BarraReserva({
  reservation: r,
  now,
  tz,
  tableNames,
  api,
  onOpenDetail,
  onClear,
}: {
  reservation: ReservationWithId | null
  now: number
  tz: string
  tableNames: ReadonlyMap<string, string>
  api: Pick<ReservationActionsApi, "act" | "busyId" | "planFor">
  onOpenDetail: (r: ReservationWithId) => void
  onClear: () => void
}) {
  if (!r) {
    return (
      <div className="flex min-h-[84px] items-center gap-3 border-t bg-surface-sunken/50 px-4 py-3 text-sm text-muted-foreground">
        <HandTapIcon aria-hidden className="size-5 shrink-0" />
        Toca una reserva de la lista o una mesa del plano para ver sus acciones.
      </div>
    )
  }
  const plan = api.planFor(r, now)
  return (
    <div role="region" aria-label={`Reserva elegida: ${r.guestName}`} className="flex flex-col gap-3 border-t bg-surface-raised px-4 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <GuestAvatar name={r.guestName} ring={r.status === "seated" ? "seated" : "none"} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="flex min-w-0 items-baseline gap-2.5">
            <span className="cifra text-lg font-semibold">{timeOf(r.startAt, tz)}</span>
            <span className="truncate text-lg font-semibold tracking-tight">{r.guestName}</span>
          </p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <ReservationStatusDot reservation={r} now={now} />
            <span className="inline-flex items-center gap-1">
              <UsersIcon aria-hidden className="size-3.5" />
              <span className="cifra text-soft-foreground">{r.partySize}</span>
            </span>
            {r.tableIds.length > 0 ? (
              <span>
                Mesa <span className="cifra font-medium text-foreground">{tableLabel(r.tableIds, tableNames)}</span>
              </span>
            ) : (
              <span className="text-warning">Sin mesa</span>
            )}
          </p>
        </div>
        <Button variant="outline" className="h-12 shrink-0 rounded-[10px] bg-card px-3.5 shadow-soft" onClick={() => onOpenDetail(r)}>
          Detalle <CaretRightIcon aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" className="size-12 shrink-0 rounded-[10px]" aria-label="Quitar la reserva elegida" onClick={onClear}>
          <XIcon />
        </Button>
      </div>
      {plan.primary || plan.secondary.length > 0 ? (
        <ReservationActionButtons reservation={r} plan={plan} api={api} size="xl" visible={r.status === "pending" ? 2 : 1} destructiveVisible />
      ) : (
        <p className="text-sm text-muted-foreground">Nada que hacer con esta reserva ahora.</p>
      )}
    </div>
  )
}
