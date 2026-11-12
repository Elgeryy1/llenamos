import { fireEvent, render, screen } from "@testing-library/react"
import type { User } from "firebase/auth"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { PanelContext, type PanelContextValue } from "@/components/panel/PanelContext"
import { Plano, type PlanoLiveTable } from "@/components/sala/Plano"
import type { TableDoc } from "@/lib/data/parse"
import { at, reservation } from "@/lib/reservas/fixtures"
import { ReservationStatusDot, ReservationTags } from "./Estado"
import { RequireReservations } from "./RequireReservations"

function panel(changes: Partial<PanelContextValue> = {}): PanelContextValue {
  return {
    user: { uid: "u1" } as User,
    restaurants: [],
    restaurant: { id: "demo", name: "Taberna Lumbre", slug: "taberna-lumbre", brandColor: "#f0a35e", currency: "EUR", timezone: "Europe/Madrid", locale: "es", isDemo: true, plan: "sala", activeModules: ["reservations", "floor", "kitchen"] },
    member: { uid: "u1", displayName: "Marta", email: "m@x.test", role: "owner", locationIds: [], active: true },
    role: "owner",
    locations: [],
    location: { id: "centro", name: "Centro", slug: "centro", address: "", city: "", phone: "" },
    selectRestaurant: () => {},
    selectLocation: () => {},
    ...changes,
  }
}

const wrap = (value: PanelContextValue, children: ReactNode) => <PanelContext value={value}>{children}</PanelContext>

describe("módulo de reservas", () => {
  it("con el módulo activo enseña la página", () => {
    render(wrap(panel(), <RequireReservations>el día</RequireReservations>))
    expect(screen.getByText("el día")).toBeTruthy()
  })

  it("sin el módulo explica por qué y no enseña nada", () => {
    const base = panel()
    render(wrap(panel({ restaurant: { ...base.restaurant, plan: "reservas", activeModules: [] } }), <RequireReservations>el día</RequireReservations>))
    expect(screen.queryByText("el día")).toBeNull()
    expect(screen.getByText("El módulo de reservas no está activo")).toBeTruthy()
    expect(screen.getByText(/Tu plan \(Reservas\)/)).toBeTruthy()
  })

  it("sin locales lo dice", () => {
    render(wrap(panel({ location: null }), <RequireReservations>el día</RequireReservations>))
    expect(screen.getByText("Este restaurante aún no tiene locales")).toBeTruthy()
  })
})

describe("estado y etiquetas de una reserva", () => {
  it("punto y palabra, con el retraso", () => {
    const r = reservation({ status: "confirmed", startAt: at("2026-11-10", "21:00") })
    render(<ReservationStatusDot reservation={r} now={at("2026-11-10", "21:12")} />)
    expect(screen.getByText("Retraso 12 min")).toBeTruthy()
  })

  it("alergia y señal", () => {
    const r = reservation({ deposit: { status: "paid", amountCents: 3000, checkoutSessionId: null } })
    render(<ReservationTags reservation={r} allergies="frutos secos" />)
    expect(screen.getByText("Alergia: frutos secos")).toBeTruthy()
    expect(screen.getByText(/Señal 30/)).toBeTruthy()
  })
})

describe("plano en directo", () => {
  const tables: TableDoc[] = [
    { id: "s1", name: "S1", areaId: "sala", seats: 2, shape: "rect", x: 6, y: 14, w: 12, h: 18, joinableWith: [], enabled: true },
    { id: "s2", name: "S2", areaId: "sala", seats: 4, shape: "round", x: 24, y: 14, w: 12, h: 18, joinableWith: [], enabled: true },
  ]
  const live = new Map<string, PlanoLiveTable>([
    ["s1", { state: "seated", line: "Familia Roca · 27 min", progress: 0.3, clickable: true }],
    ["s2", { state: "free", line: "Libre", progress: 0, clickable: false }],
  ])

  it("la mesa con reserva es un botón que dice su estado; la libre no se pulsa", () => {
    const onSelect = vi.fn()
    render(<Plano label="Sala" tables={tables} names={new Map()} live={live} onSelect={onSelect} />)
    const s1 = screen.getByRole("button", { name: /Mesa S1.*sentados: Familia Roca · 27 min/ })
    fireEvent.click(s1)
    expect(onSelect).toHaveBeenCalledWith("s1")
    expect(screen.queryByRole("button", { name: /Mesa S2/ })).toBeNull()
    expect(screen.getByRole("listitem", { name: /Mesa S2.*libre: Libre/ })).toBeTruthy()
  })
})
