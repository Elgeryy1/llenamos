import type { ReservationWithId } from "@llenamos/core"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { planoLiveMap } from "@/components/sala/plano-live"
import type { AreaDoc, TableDoc } from "@/lib/data/parse"
import { groupByShift } from "@/lib/reservas/dia"
import { actionsFor } from "@/lib/reservas/estados"
import { at, config, reservation, TZ } from "@/lib/reservas/fixtures"
import { liveTables } from "@/lib/reservas/sala"
import { planByArea } from "@/lib/sala/plano"
import { ShiftList } from "./ListaDia"
import { BarraReserva, PlanoReservas, usePartida, zoneOfTables } from "./VistaPartida"

const DAY = "2026-11-10"
const NOW = at(DAY, "21:10")
const areas: AreaDoc[] = [
  { id: "sala", name: "Sala", sortOrder: 0 },
  { id: "terraza", name: "Terraza", sortOrder: 1 },
]
const tables: TableDoc[] = [
  { id: "s1", name: "S1", areaId: "sala", seats: 2, shape: "rect", x: 6, y: 14, w: 12, h: 18, joinableWith: [], enabled: true },
  { id: "s2", name: "S2", areaId: "sala", seats: 4, shape: "round", x: 30, y: 14, w: 12, h: 18, joinableWith: [], enabled: true },
  { id: "t1", name: "T1", areaId: "terraza", seats: 4, shape: "rect", x: 10, y: 20, w: 14, h: 18, joinableWith: [], enabled: true },
]
const names = new Map(tables.map((t) => [t.id, t.name] as const))

const sentada = reservation({ guestName: "Pau Ferrer", tableIds: ["s1"], startAt: at(DAY, "20:30"), status: "seated" })
const porLlegar = reservation({ guestName: "Núria Bosch", tableIds: ["s2"], startAt: at(DAY, "21:30"), partySize: 4 })
const terraza = reservation({ guestName: "Iván Prieto", tableIds: ["t1"], startAt: at(DAY, "21:00"), status: "no_show" })
const list = [sentada, porLlegar, terraza]

function Harness({ split, onOpenDetail, act, initialHidden = false }: { split: boolean; onOpenDetail: (r: ReservationWithId) => void; act?: (r: ReservationWithId, a: unknown) => void; initialHidden?: boolean }) {
  const [hidden, setHidden] = useState(initialHidden)
  const byTable = liveTables(tables, list, NOW)
  const live = planoLiveMap(byTable, TZ)
  const p = usePartida({ split, reservations: list, byTable, onOpenDetail, onReveal: () => setHidden(false) })
  const groups = groupByShift(list, config(), DAY)
  const api = {
    act: async (r: ReservationWithId, a: unknown) => {
      act?.(r, a)
    },
    busyId: null,
    planFor: (r: ReservationWithId, now: number) => actionsFor(r, now, names, { canManage: true }),
  }
  return (
    <div className="@container/lista">
      {!hidden && groups.map((g) => (
        <ShiftList key={g.shift.index} group={g} now={NOW} tz={TZ} tableNames={names} customers={new Map()} selectedId={p.selectedId} onOpen={p.selectRow} />
      ))}
      <PlanoReservas
        areas={areas}
        tables={tables}
        names={names}
        live={live}
        selectedTableIds={p.selected?.tableIds ?? []}
        onSelectTable={p.selectTable}
        footer={<BarraReserva reservation={p.selected} now={NOW} tz={TZ} tableNames={names} api={api} onOpenDetail={onOpenDetail} onClear={p.clear} />}
      />
    </div>
  )
}

const row = (name: RegExp) => screen.getByRole("button", { name })
const mesa = (name: string) => screen.getByRole("button", { name: new RegExp(`^Mesa ${name},`) })

describe("vista partida: lista y plano a la vez", () => {
  const scroll = vi.fn()
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })))
    Element.prototype.scrollIntoView = scroll
  })
  afterEach(() => {
    scroll.mockReset()
    vi.unstubAllGlobals()
  })

  it("tocar una reserva resalta su mesa y enseña su barra; el segundo toque abre el detalle", () => {
    const open = vi.fn()
    render(<Harness split onOpenDetail={open} />)
    expect(screen.getByText(/Toca una reserva de la lista/)).toBeTruthy()

    fireEvent.click(row(/^Núria Bosch a las 21:30/))
    expect(row(/^Núria Bosch a las 21:30/).getAttribute("aria-pressed")).toBe("true")
    expect(mesa("S2").getAttribute("aria-pressed")).toBe("true")
    expect(mesa("S1").getAttribute("aria-pressed")).toBe("false")
    const barra = screen.getByRole("region", { name: "Reserva elegida: Núria Bosch" })
    // Botones de mostrador de 48 px: sentar en su mesa, cambiar mesa y cancelar a la vista.
    const sentar = within(barra).getByRole("button", { name: "Sentar en S2" })
    expect(sentar.className).toContain("h-12")
    expect(within(barra).getByRole("button", { name: "Cambiar mesa" })).toBeTruthy()
    expect(within(barra).getByRole("button", { name: /Cancelar reserva: Núria Bosch/ })).toBeTruthy()
    expect(open).not.toHaveBeenCalled()

    fireEvent.click(row(/^Núria Bosch a las 21:30/))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ guestName: "Núria Bosch" }))
  })

  it("si la mesa está en otra zona, el plano cambia solo a esa zona", () => {
    render(<Harness split onOpenDetail={() => {}} />)
    expect(screen.getByRole("region", { name: "Plano de la zona Sala" })).toBeTruthy()
    fireEvent.click(row(/^Iván Prieto a las 21:00/))
    expect(screen.getByRole("region", { name: "Plano de la zona Terraza" })).toBeTruthy()
    // No se presentó: su mesa ya no está ocupada, pero se resalta igual.
    expect(document.querySelector("[data-elegida]")?.getAttribute("aria-label")).toMatch(/^Mesa T1,/)
    // No se presentó: la acción principal dice que llegó tarde.
    const barra = screen.getByRole("region", { name: "Reserva elegida: Iván Prieto" })
    expect(within(barra).getByRole("button", { name: "Llegó tarde: sentar en T1" })).toBeTruthy()
  })

  it("en una pendiente, cambiar mesa sigue a la vista junto a confirmar y sentar", () => {
    const pendiente = { ...porLlegar, status: "pending" as const }
    render(<BarraReserva reservation={pendiente} now={NOW} tz={TZ} tableNames={names}
      api={{ act: vi.fn(), busyId: null, planFor: (r, now) => actionsFor(r, now, names, { canManage: true }) }}
      onOpenDetail={() => {}} onClear={() => {}} />)
    const barra = screen.getByRole("region", { name: "Reserva elegida: Núria Bosch" })
    expect(within(barra).getByRole("button", { name: "Confirmar" })).toBeTruthy()
    expect(within(barra).getByRole("button", { name: "Sentar en S2" })).toBeTruthy()
    expect(within(barra).getByRole("button", { name: "Cambiar mesa" })).toBeTruthy()
  })

  it("tocar una mesa elige su reserva y trae su fila a la vista", () => {
    render(<Harness split onOpenDetail={() => {}} />)
    fireEvent.click(mesa("S1"))
    expect(row(/^Pau Ferrer a las 20:30/).getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByRole("region", { name: "Reserva elegida: Pau Ferrer" })).toBeTruthy()
    expect(scroll).toHaveBeenCalled()
  })

  it("muestra la fila antes de desplazarla y respeta la preferencia de reducir movimiento", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })))
    render(<Harness split initialHidden onOpenDetail={() => {}} />)
    expect(screen.queryByRole("button", { name: /^Pau Ferrer a las/ })).toBeNull()
    fireEvent.click(mesa("S1"))
    expect(row(/^Pau Ferrer a las/).getAttribute("aria-pressed")).toBe("true")
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "instant" })
  })

  it("en el móvil no hay selección: tocar abre el detalle", () => {
    const open = vi.fn()
    render(<Harness split={false} onOpenDetail={open} />)
    fireEvent.click(row(/^Pau Ferrer a las 20:30/))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ guestName: "Pau Ferrer" }))
    fireEvent.click(mesa("S2"))
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ guestName: "Núria Bosch" }))
    expect(screen.queryByRole("region", { name: /Reserva elegida/ })).toBeNull()
  })

  it("la acción de la barra usa la misma acción de siempre", () => {
    const act = vi.fn()
    render(<Harness split onOpenDetail={() => {}} act={act} />)
    fireEvent.click(mesa("S1"))
    fireEvent.click(screen.getByRole("button", { name: "Terminar y liberar mesa" }))
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ guestName: "Pau Ferrer" }), expect.objectContaining({ kind: "status", to: "finished" }))
  })
})

describe("zona de una reserva", () => {
  it("es la de su primera mesa; sin mesa, ninguna", () => {
    const plans = planByArea(areas, tables)
    expect(zoneOfTables(plans, ["t1"])?.area?.id).toBe("terraza")
    expect(zoneOfTables(plans, [])).toBeUndefined()
  })
})
