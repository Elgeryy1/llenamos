/** Datos para las pruebas de reservas (no se usa en la aplicación). */
import { configuracionReservasInicial, instanteDeHoraLocal, type ConfiguracionReservas, type ReservationWithId } from "@llenamos/core"

export const TZ = "Europe/Madrid"

export function config(changes: Partial<ConfiguracionReservas> = {}): ConfiguracionReservas {
  return { ...configuracionReservasInicial(TZ), ...changes }
}

/** Instante de una hora de pared en Madrid. */
export function at(date: string, time: string): number {
  const [h, m] = time.split(":").map(Number)
  const ms = instanteDeHoraLocal(date, (h ?? 0) * 60 + (m ?? 0), TZ)
  if (ms === null) throw new Error(`Hora inexistente: ${date} ${time}`)
  return ms
}

let n = 0

export function reservation(changes: Partial<ReservationWithId> = {}): ReservationWithId {
  n += 1
  return {
    id: `r${n}`,
    guestName: `Cliente ${n}`,
    phone: "+34612345678",
    email: null,
    language: "es",
    partySize: 2,
    startAt: at("2026-11-10", "21:00"),
    durationMinutes: 90,
    status: "confirmed",
    tableIds: [],
    suggestedTableIds: [],
    suggestionReason: null,
    source: "phone",
    notes: "",
    guestNotes: "",
    customerId: "0123456789abcdef0123",
    reference: "K7Q2MD",
    manageTokenHash: "0".repeat(64),
    deposit: { status: "none", amountCents: 0, checkoutSessionId: null },
    history: [],
    createdBy: null,
    ...changes,
  }
}
