import { settingsToConfiguracion } from "../adapters"
import type { ReservationSettings } from "../reservation-settings"
import { horaLocal, instanteDeHoraLocal, sumarDias } from "../reservas/tiempo"
import { rangoTurno, turnosDelDia } from "../reservas/horarios"
import type { FloorSettings } from "./modelo"

/** La última entrada del turno cuenta hasta el final de ese minuto, también tras medianoche. */
export function tableOrderingAllowed(settings: Pick<FloorSettings, "allowOrdersOutsideHours">, reservations: ReservationSettings, now: number): boolean {
  if (settings.allowOrdersOutsideHours !== false) return true
  const config = settingsToConfiguracion(reservations)
  const today = horaLocal(now, config.zonaHoraria).fecha
  return [today, sumarDias(today, -1)].some(date => turnosDelDia(config, date).turnos.some(shift => {
    const range = rangoTurno(shift)
    const start = instanteDeHoraLocal(date, range.desde, config.zonaHoraria)
    const end = instanteDeHoraLocal(range.ultimaEntrada >= 1440 ? sumarDias(date, 1) : date, range.ultimaEntrada % 1440, config.zonaHoraria)
    return start !== null && end !== null && now >= start && now < end + 60000
  }))
}
