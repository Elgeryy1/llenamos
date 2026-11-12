import { timeOf } from "@/lib/reservas/formato"
import { liveLine, type TableLive } from "@/lib/reservas/sala"
import type { PlanoLiveTable } from "./Plano"

/**
 * Lo que se pinta en una mesa del plano a partir de su estado en directo: el cliente que
 * manda y su dato corto (minutos sentados o la hora de llegada). Lo usan la sala y la
 * vista partida de reservas.
 */
export function planoLive(t: TableLive, tz: string): PlanoLiveTable {
  const r = t.current
  const seated = t.state === "seated" || t.state === "overtime"
  return {
    state: t.state,
    line: liveLine(t, tz),
    progress: t.progress,
    clickable: r !== null,
    guest: r?.guestName,
    detail: seated ? `${t.minutes}′` : r ? timeOf(r.startAt, tz) : undefined,
    party: seated ? r?.partySize : undefined,
  }
}

export function planoLiveMap(byTable: ReadonlyMap<string, TableLive>, tz: string): Map<string, PlanoLiveTable> {
  const out = new Map<string, PlanoLiveTable>()
  for (const [id, t] of byTable) out.set(id, planoLive(t, tz))
  return out
}
