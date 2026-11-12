"use client"

import type { ReservationWithId } from "@llenamos/core"
import { useState } from "react"
import { toast } from "sonner"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { llamarCore } from "@/lib/data/callables"
import { tableLabel } from "@/lib/reservas/estados"
import { timeOf } from "@/lib/reservas/formato"
import { useMutation } from "@/lib/reservas/hooks"
import { useProposals } from "@/lib/reservas/useProposals"
import { TableProposalPicker } from "./TableProposals"

/** Asignar o cambiar la mesa de una reserva con las propuestas del motor. */
export function TablesDialog({
  open,
  onOpenChange,
  reservation,
  restaurantId,
  locationId,
  tableNames,
  timezone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  reservation: ReservationWithId
  restaurantId: string
  locationId: string
  tableNames: ReadonlyMap<string, string>
  timezone: string
}) {
  const [selected, setSelected] = useState<string[] | null>(null)
  const proposals = useProposals(open ? { restaurantId, locationId, reservationId: reservation.id, limit: 6 } : null)
  const assign = useMutation(async (tableIds: string[]) => {
    await llamarCore("asignarMesas", { restaurantId, locationId, reservationId: reservation.id, tableIds })
  })

  function close() {
    if (assign.pending) return
    setSelected(null)
    assign.reset()
    onOpenChange(false)
  }

  async function save(tableIds: string[]) {
    const ok = await assign.run(tableIds)
    if (!ok) return
    toast.success(tableIds.length > 0 ? `${reservation.guestName}: mesa ${tableLabel(tableIds, tableNames)}` : `${reservation.guestName}: sin mesa`)
    setSelected(null)
    onOpenChange(false)
  }

  const has = reservation.tableIds.length > 0
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{has ? "Cambiar mesa" : "Asignar mesa"}</DialogTitle>
          <DialogDescription>
            {reservation.guestName}, {reservation.partySize} {reservation.partySize === 1 ? "persona" : "personas"} a las{" "}
            <span className="cifra">{timeOf(reservation.startAt, timezone)}</span>
            {has ? (
              <>
                . Ahora en <span className="cifra">{tableLabel(reservation.tableIds, tableNames)}</span>
              </>
            ) : null}
            .
          </DialogDescription>
        </DialogHeader>
        <TableProposalPicker state={proposals} selected={selected} onSelect={setSelected} current={reservation.tableIds} name={`mesas-${reservation.id}`} />
        {assign.error ? (
          <Notice tone="error" title="No se ha podido cambiar la mesa" detail={assign.error.code}>
            {assign.error.message}
          </Notice>
        ) : null}
        <DialogFooter className="gap-2">
          {has ? (
            <Button variant="ghost" size="lg" disabled={assign.pending} onClick={() => void save([])}>
              Quitar mesa
            </Button>
          ) : null}
          <Button variant="outline" size="lg" disabled={assign.pending} onClick={close}>
            Volver
          </Button>
          <Button size="lg" disabled={assign.pending || selected === null} onClick={() => selected && void save(selected)}>
            {assign.pending ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
            {assign.pending ? "Guardando…" : selected ? `Poner en ${tableLabel(selected, tableNames)}` : "Elige una mesa"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
