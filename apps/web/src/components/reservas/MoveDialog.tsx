"use client"

import { horaLocal, type ConfiguracionReservas, type ReservationWithId } from "@llenamos/core"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { DatePicker } from "@/components/common/date-picker"
import { TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { llamarCore } from "@/lib/data/callables"
import type { TableDoc } from "@/lib/data/parse"
import { useDayReservations } from "@/lib/data/reservas"
import { staffAvailability } from "@/lib/reservas/disponibilidad"
import { dateToFecha, fechaToDate, longDate } from "@/lib/reservas/formato"
import { useMutation, useNow } from "@/lib/reservas/hooks"
import { SlotSelect } from "./SlotSelect"

/** Mover una reserva a otro día, otra hora u otro número de personas. */
export function MoveDialog({
  open,
  onOpenChange,
  reservation,
  restaurantId,
  locationId,
  config,
  tables,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  reservation: ReservationWithId
  restaurantId: string
  locationId: string
  config: ConfiguracionReservas
  tables: readonly TableDoc[]
}) {
  const now = useNow()
  const current = horaLocal(reservation.startAt, config.zonaHoraria)
  const [date, setDate] = useState(current.fecha)
  const [time, setTime] = useState(current.hora)
  const [size, setSize] = useState(String(reservation.partySize))
  const partySize = Number.parseInt(size, 10)
  const validSize = Number.isInteger(partySize) && partySize >= 1 && partySize <= 200

  const dayReservations = useDayReservations(restaurantId, open ? locationId : null, date, config)
  const availability = useMemo(() => {
    if (!open || dayReservations.status !== "ready" || !validSize) return null
    return staffAvailability({ config, date, partySize, tables, reservations: dayReservations.data, now, excludeReservationId: reservation.id })
  }, [open, dayReservations, validSize, config, date, partySize, tables, now, reservation.id])

  const move = useMutation(async () => {
    await llamarCore("moverReserva", {
      restaurantId,
      locationId,
      reservationId: reservation.id,
      date,
      time,
      ...(partySize !== reservation.partySize ? { partySize } : {}),
    })
  })

  function close() {
    if (move.pending) return
    move.reset()
    onOpenChange(false)
  }

  async function submit() {
    if (await move.run()) {
      toast.success(`${reservation.guestName}: ${longDate(date)} a las ${time}`)
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mover la reserva</DialogTitle>
          <DialogDescription>
            {reservation.guestName}. Si su mesa no queda libre a la nueva hora, se le quita y el motor propone otra. Se le avisa del cambio.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Día</span>
            <DatePicker value={fechaToDate(date)} onChange={(d) => setDate(dateToFecha(d))} label="Día de la reserva" />
          </div>
          <TextField
            label="Personas"
            type="number"
            inputMode="numeric"
            min={1}
            max={200}
            value={size}
            onChange={(e) => setSize(e.target.value)}
            error={validSize ? null : "Escribe cuántas personas vienen."}
          />
          <SlotSelect availability={availability} value={time} onChange={setTime} extra={date === current.fecha ? current.hora : null} />
          {move.error ? (
            <Notice tone="error" title="No se ha podido mover" detail={move.error.code}>
              {move.error.message}
            </Notice>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" disabled={move.pending} onClick={close}>
              Volver
            </Button>
            <Button type="submit" size="lg" disabled={move.pending || !validSize || time === ""}>
              {move.pending ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
              {move.pending ? "Moviendo…" : "Mover"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
