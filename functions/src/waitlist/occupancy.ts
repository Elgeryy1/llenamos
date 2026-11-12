import { settingsToConfiguracion, duracionParaGrupo, type WaitlistEntry, type ReservationSettings } from '@llenamos/core'

/** Ocupación común de R1 y R2; cada oferta vigente se cuenta una vez. */
export function offeredOccupancy(id: string, entry: WaitlistEntry, settings: ReservationSettings, now: number) {
 if (entry.status !== 'offered' || !entry.offer || entry.offer.expiresAt <= now) return []
 const config = settingsToConfiguracion(settings)
 const duration = duracionParaGrupo(config, entry.partySize)
 return [{ id: `waitlist-${id}`, inicio: entry.offer.startAt, duracionMinutos: duration, comensales: entry.partySize, estado: 'pendiente' as const, mesaIds: [] }]
}
