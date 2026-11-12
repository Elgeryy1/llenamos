"use client"

import type { ReservationWithId } from "@llenamos/core"
import { CaretRightIcon, UsersIcon } from "@phosphor-icons/react"
import { useMemo } from "react"
import { Tag } from "@/components/common/tag"
import { cn } from "@/lib/cn"
import type { CustomerDoc } from "@/lib/data/reservas"
import { halfHourOf, isDropped, type ShiftGroup } from "@/lib/reservas/dia"
import { tableLabel, visibleStatus } from "@/lib/reservas/estados"
import { timeOf } from "@/lib/reservas/formato"
import { ReservationStatusDot } from "./Estado"
import { GuestAvatar, GuestBadges, SourceLabel, type AvatarRing } from "./Huesped"

/** Id del elemento de una fila, para traerla a la vista al tocar su mesa en el plano. */
export const rowDomId = (id: string) => `reserva-${id}`

/**
 * La lista del día de la propuesta B: un turno por superficie y un separador por media hora
 * con sus cubiertos. Las filas se adaptan al ancho de su caja (container queries), no al de
 * la pantalla: la misma lista vale a todo el ancho, en la columna de la vista partida y en el
 * móvil. La caja que la contiene lleva `@container/lista`.
 */
export function ShiftList({
  group,
  now,
  tz,
  tableNames,
  customers,
  selectedId,
  onOpen,
}: {
  group: ShiftGroup
  now: number
  tz: string
  tableNames: ReadonlyMap<string, string>
  customers: ReadonlyMap<string, CustomerDoc>
  selectedId: string | null
  onOpen: (r: ReservationWithId) => void
}) {
  const slots = useMemo(() => {
    const out: Array<{ label: string; covers: number; list: ReservationWithId[] }> = []
    for (const r of group.reservations) {
      const label = halfHourOf(r.startAt, tz)
      let slot = out.at(-1)
      if (!slot || slot.label !== label) {
        slot = { label, covers: 0, list: [] }
        out.push(slot)
      }
      slot.list.push(r)
      if (!isDropped(r.status)) slot.covers += r.partySize
    }
    return out
  }, [group.reservations, tz])

  return (
    <section aria-labelledby={`turno-${group.shift.index}`} className="flex flex-col gap-3">
      <h2 id={`turno-${group.shift.index}`} className="flex items-baseline gap-2.5 px-1">
        <span className="text-lg font-semibold tracking-tight">{group.shift.name}</span>
        {group.shift.index >= 0 ? (
          <span className="cifra text-sm text-muted-foreground">
            {group.shift.from} a {group.shift.lastEntry}
          </span>
        ) : null}
        <span className="ml-auto text-sm text-muted-foreground">
          <span className="cifra text-soft-foreground">{group.covers}</span> {group.covers === 1 ? "cubierto" : "cubiertos"}
        </span>
      </h2>
      <div className="superficie overflow-hidden">
        {slots.map((slot) => (
          <div key={slot.label} className="border-b last:border-b-0">
            <div className="flex items-center gap-3 border-b bg-surface-sunken/50 px-4 py-1.5 text-xs text-muted-foreground @md/lista:px-5">
              <span className="cifra font-medium text-soft-foreground">{slot.label}</span>
              <span aria-hidden className="h-px flex-1 bg-border" />
              <span>
                <span className="cifra">{slot.covers}</span> {slot.covers === 1 ? "cubierto" : "cubiertos"}
              </span>
            </div>
            <ul className="divide-y">
              {slot.list.map((r) => (
                <li key={r.id} id={rowDomId(r.id)} className="scroll-mt-28">
                  <ReservationRow reservation={r} now={now} tz={tz} tableNames={tableNames} customer={customers.get(r.customerId) ?? null} selected={r.id === selectedId} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

/** Una reserva en una fila: hora grande, cliente con sus etiquetas, personas, mesa y estado. */
export function ReservationRow({
  reservation: r,
  now,
  tz,
  tableNames,
  customer,
  selected,
  onOpen,
}: {
  reservation: ReservationWithId
  now: number
  tz: string
  tableNames: ReadonlyMap<string, string>
  customer: CustomerDoc | null
  selected: boolean
  onOpen: (r: ReservationWithId) => void
}) {
  const v = visibleStatus(r, now)
  const ring: AvatarRing = v.muted ? "muted" : v.tone === "seated" ? "seated" : v.tone === "late" ? "late" : "none"
  const closed = r.status === "finished" || r.status === "cancelled" || r.status === "no_show"
  const time = timeOf(r.startAt, tz)
  return (
    <button
      type="button"
      data-reserva-fila
      data-selected={selected || undefined}
      aria-pressed={selected}
      onClick={() => onOpen(r)}
      aria-label={`${r.guestName} a las ${time}, ${r.partySize} ${r.partySize === 1 ? "persona" : "personas"}, ${r.tableIds.length > 0 ? `mesa ${tableLabel(r.tableIds, tableNames)}` : "sin mesa"}, ${v.label}`}
      className={cn(
        "group grid w-full grid-cols-[3.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors duration-150 ease-(--ease-llenamos) hover:bg-surface-raised focus-visible:bg-surface-raised @md/lista:px-5",
        "@2xl/lista:grid-cols-[3.75rem_2.25rem_minmax(0,1fr)_3.5rem_5.5rem_12.5rem_1rem] @2xl/lista:gap-x-4",
        v.muted && !selected && "opacity-60 hover:opacity-100",
        selected && "bg-surface-raised shadow-[inset_3px_0_0_0_var(--primary)]",
      )}
    >
      <span className={cn("cifra row-span-2 self-start text-[17px] leading-6 font-medium @2xl/lista:row-span-1 @2xl/lista:self-center @2xl/lista:text-lg", v.tone === "late" && "text-warning")}>{time}</span>
      <GuestAvatar name={r.guestName} ring={ring} className="hidden @2xl/lista:flex" />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[15px] font-medium">{r.guestName}</span>
          <SourceLabel source={r.source} className="hidden shrink-0 @md/lista:inline-flex" />
          {customer && customer.visits > 1 ? (
            <span className="hidden shrink-0 text-xs text-muted-foreground @4xl/lista:inline">
              · <span className="cifra">{customer.visits}</span> visitas
            </span>
          ) : null}
        </span>
        <GuestBadges reservation={r} customer={customer} max={4} />
      </span>
      <span className="inline-flex items-center gap-1.5 justify-self-end text-sm text-soft-foreground @2xl/lista:justify-self-start">
        <UsersIcon aria-hidden className="size-4 text-muted-foreground" />
        <span className="cifra">{r.partySize}</span>
      </span>
      <span className="col-start-2 row-start-2 min-w-0 @2xl/lista:col-start-auto @2xl/lista:row-start-auto">
        <ReservationStatusDot reservation={r} now={now} />
      </span>
      <span className="col-start-3 row-start-2 justify-self-end @2xl/lista:col-start-5 @2xl/lista:row-start-1 @2xl/lista:justify-self-start">
        {r.tableIds.length > 0 ? (
          <span className="cifra inline-flex h-7 items-center rounded-md border bg-surface-sunken/60 px-2 text-sm font-medium">{tableLabel(r.tableIds, tableNames)}</span>
        ) : closed ? (
          <span className="text-muted-foreground">·</span>
        ) : (
          <span className="flex flex-col items-end gap-0.5 @2xl/lista:items-start">
            <Tag tone="aviso">Sin mesa</Tag>
            {r.suggestedTableIds.length > 0 ? <span className="cifra text-[11px] text-muted-foreground">{tableLabel(r.suggestedTableIds, tableNames)} sugerida</span> : null}
          </span>
        )}
      </span>
      <CaretRightIcon aria-hidden className="hidden size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 @2xl/lista:block" />
    </button>
  )
}
