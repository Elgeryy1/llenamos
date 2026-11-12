import type { ReservationStatus } from "@llenamos/core"
import { cn } from "@/lib/cn"

/**
 * Estado de una reserva: punto de 8 px y palabra (nunca solo color). Sigue el patrón
 * «status badge con punto» de coss (p-badge-16/17/18) sobre los colores de la marca.
 *
 * Los estados guardados (`pending`, `confirmed`, `seated`, `finished`, `cancelled`,
 * `no_show`) se pintan con `StatusDot` (pásale `ESTADO_DE_STATUS[status]`); «por llegar» y «retraso» son lecturas
 * de una reserva confirmada según la hora (ver `estadoVisible`).
 */
export type EstadoReserva =
  | "pendiente"
  | "confirmada"
  | "por_llegar"
  | "retraso"
  | "sentada"
  | "terminada"
  | "cancelada"
  | "no_presentada"

interface Aspecto {
  label: string
  /** Color del texto. */
  text: string
  /** Relleno y aro del punto. */
  dot: string
}

export const ESTADOS: Record<EstadoReserva, Aspecto> = {
  pendiente: { label: "Pendiente", text: "text-soft-foreground", dot: "border-warning bg-transparent border-dashed" },
  confirmada: { label: "Confirmada", text: "text-soft-foreground", dot: "border-muted-foreground bg-muted-foreground" },
  por_llegar: { label: "Por llegar", text: "text-soft-foreground", dot: "border-muted-foreground bg-transparent" },
  retraso: { label: "Retraso", text: "text-warning", dot: "border-warning bg-warning" },
  sentada: { label: "Sentada", text: "text-success", dot: "border-success bg-success" },
  terminada: { label: "Terminada", text: "text-muted-foreground", dot: "border-ash bg-ash" },
  cancelada: { label: "Cancelada", text: "text-destructive", dot: "border-destructive bg-transparent" },
  no_presentada: { label: "No se presentó", text: "text-destructive", dot: "border-destructive bg-destructive" },
}

/** Estado guardado en Firestore (`Reservation.status`) → estado que se enseña. */
export const ESTADO_DE_STATUS = {
  pending: "pendiente",
  confirmed: "confirmada",
  seated: "sentada",
  finished: "terminada",
  cancelled: "cancelada",
  no_show: "no_presentada",
} as const satisfies Record<ReservationStatus, EstadoReserva>

/**
 * Lo que se enseña en la lista del día: una reserva confirmada es «por llegar» hasta su
 * hora y «retraso N min» a partir de `margenMinutos` después. El resto, tal cual.
 */
export function estadoVisible(
  status: ReservationStatus,
  startAt: number,
  ahora: number,
  margenMinutos = 5,
): { estado: EstadoReserva; label: string } {
  if (status === "confirmed") {
    const tarde = Math.floor((ahora - startAt) / 60_000)
    if (tarde >= margenMinutos) return { estado: "retraso", label: `Retraso ${tarde} min` }
    return { estado: "por_llegar", label: ESTADOS.por_llegar.label }
  }
  const estado = ESTADO_DE_STATUS[status]
  return { estado, label: ESTADOS[estado].label }
}

/** Punto y palabra. `label` cambia el texto («Retraso 12 min»). */
export function StatusDot({
  estado,
  label,
  className,
}: {
  estado: EstadoReserva
  label?: string
  className?: string
}) {
  const a = ESTADOS[estado]
  return (
    <span data-estado={estado} className={cn("inline-flex items-center gap-2 text-[13px] whitespace-nowrap", a.text, className)}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full border-[1.5px]", a.dot)} />
      {label ?? a.label}
    </span>
  )
}

/** Lo mismo en una píldora con borde, para la cabecera del detalle de una reserva. */
export function StatusPill({ estado, label, className }: { estado: EstadoReserva; label?: string; className?: string }) {
  return <StatusDot estado={estado} label={label} className={cn("h-6 rounded-full border px-2.5 text-xs", className)} />
}
