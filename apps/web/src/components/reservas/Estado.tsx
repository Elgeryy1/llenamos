import type { ReservationWithId } from "@llenamos/core"
import { StatusDot, StatusPill, type EstadoReserva } from "@/components/common/reservation-status"
import { Tag } from "@/components/common/tag"
import { visibleStatus, type StatusTone } from "@/lib/reservas/estados"
import { euros } from "@/lib/reservas/formato"

function estadoFor(tone: StatusTone, status: ReservationWithId["status"]): EstadoReserva {
  switch (tone) {
    case "waiting":
      return "por_llegar"
    case "late":
      return "retraso"
    case "pending":
      return "pendiente"
    case "seated":
      return "sentada"
    case "finished":
      return "terminada"
    case "cancelled":
      return status === "no_show" ? "no_presentada" : "cancelada"
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Punto y palabra del estado tal como se lee ahora («Retraso 12 min»). */
export function ReservationStatusDot({ reservation, now, pill }: { reservation: Pick<ReservationWithId, "status" | "startAt">; now: number; pill?: boolean }) {
  const v = visibleStatus(reservation, now)
  const estado = estadoFor(v.tone, reservation.status)
  return pill ? <StatusPill estado={estado} label={capital(v.label)} /> : <StatusDot estado={estado} label={capital(v.label)} />
}

/** Etiquetas de una reserva: alergias del cliente, señal y notas. */
export function ReservationTags({ reservation, allergies }: { reservation: ReservationWithId; allergies?: string | null }) {
  const tags: Array<{ key: string; tone: "alergia" | "neutro" | "aviso" | "habitual"; label: string }> = []
  if (allergies) tags.push({ key: "alergia", tone: "alergia", label: `Alergia: ${allergies}` })
  const d = reservation.deposit
  if (d.status === "paid") tags.push({ key: "senal", tone: "neutro", label: `Señal ${euros(d.amountCents)}` })
  else if (d.status === "required" || d.status === "failed") tags.push({ key: "senal", tone: "aviso", label: `Señal sin pagar ${euros(d.amountCents)}` })
  else if (d.status === "not_configured") tags.push({ key: "senal", tone: "aviso", label: "Señal sin pagos configurados" })
  if (reservation.guestNotes) tags.push({ key: "nota", tone: "neutro", label: "Nota del cliente" })
  if (tags.length === 0) return null
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <Tag key={t.key} tone={t.tone} className="max-w-56 truncate">
          {t.label}
        </Tag>
      ))}
    </span>
  )
}
