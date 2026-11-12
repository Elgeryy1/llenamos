"use client"

import type { ReservationWithId } from "@llenamos/core"
import { useState } from "react"
import { TextareaField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import type { ErrorInfo } from "@/lib/firebase/errors"
import type { ReservationAction } from "@/lib/reservas/estados"

type StatusAction = Extract<ReservationAction, { kind: "status" }>

const COPY: Partial<Record<StatusAction["to"], { title: string; body: string; button: string; busy: string }>> = {
  cancelled: {
    title: "Cancelar la reserva",
    body: "La mesa queda libre y, si tiene correo o WhatsApp, se le avisa de la cancelación. No se puede deshacer.",
    button: "Cancelar reserva",
    busy: "Cancelando…",
  },
  no_show: {
    title: "Marcar que no se ha presentado",
    body: "La mesa queda libre y cuenta como no presentado en su ficha. Si llega más tarde, aún se podrá sentar.",
    button: "No se ha presentado",
    busy: "Guardando…",
  },
}

/** Confirmación de cancelar o marcar no presentada, con motivo opcional. */
export function StatusConfirmDialog({
  reservation,
  action,
  onClose,
  onConfirm,
  pending,
  error,
}: {
  reservation: ReservationWithId
  action: StatusAction | null
  onClose: () => void
  onConfirm: (reason: string) => void
  pending: boolean
  error: ErrorInfo | null
}) {
  const [reason, setReason] = useState("")
  const copy = action ? COPY[action.to] : undefined
  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open && !pending) {
          setReason("")
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy?.title ?? action?.label}</DialogTitle>
          <DialogDescription>
            {reservation.guestName}, {reservation.partySize} {reservation.partySize === 1 ? "persona" : "personas"}. {copy?.body}
          </DialogDescription>
        </DialogHeader>
        <TextareaField
          label="Motivo (opcional)"
          hint="Queda en el historial de la reserva."
          value={reason}
          maxLength={200}
          onChange={(e) => setReason(e.target.value)}
        />
        {error ? (
          <Notice tone="error" title="No se ha podido guardar" detail={error.code}>
            {error.message}
          </Notice>
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="lg" disabled={pending} onClick={onClose}>
            Volver
          </Button>
          <Button variant="destructive" size="lg" disabled={pending} onClick={() => onConfirm(reason)}>
            {pending ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
            {pending ? copy?.busy : (copy?.button ?? action?.label)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
