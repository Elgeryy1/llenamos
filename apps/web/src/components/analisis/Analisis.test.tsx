import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { comparePeriods, deriveMetrics, emptyTotals, forecastDay } from "@llenamos/core"
import { panelEjemplo, previsionEjemplo } from "@/lib/analisis/fixtures"
import { cambio, METRICAS } from "@/lib/analisis/presentacion"
import { Datos } from "./Ventas"
import { Analisis } from "./Analisis"

const mock = vi.hoisted(() => ({ role: "owner", restaurant: { id: "demo", name: "Lumbre", timezone: "Europe/Madrid", plan: "completo" } }))
vi.mock("@/components/panel/PanelContext", () => ({ usePanel: () => ({ ...mock, location: { id: "centro", name: "Centro" }, locations: [], user: { uid: "u" } }) }))
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: vi.fn() }) }))
afterEach(cleanup)
const data = panelEjemplo("2026-11-01", "2026-11-07", ["centro"], 60)
describe("Cifras con las definiciones de core", () => {
  it("no inventa un 0 % sin base anterior ni denominador", () => {
    const t = emptyTotals()
    const comparison = comparePeriods(t, null)
    expect(cambio(comparison.grossSalesCents)).toBe("Sin base anterior")
    expect(deriveMetrics(t).occupancyBp).toBeNull()
    render(<Datos datos={{ ...data, total: deriveMetrics(t), comparison }} margen={false} ventas nombres={new Map()} compare="previous" slot={60} onSlot={vi.fn()} />)
    expect(screen.getAllByText("Sin base anterior").length).toBeGreaterThan(0)
    expect(screen.queryByText("0 % respecto al anterior")).toBeNull()
    expect(screen.getByText(METRICAS.find((m) => m.key === "grossSalesCents")!.definition)).toBeTruthy()
  })
  it("la presentación usa los cocientes de core y oculta el margen sin permiso", () => {
    render(<Datos datos={data} margen={false} ventas nombres={new Map()} compare="previous" slot={60} onSlot={vi.fn()} />)
    expect(screen.queryByText("El margen de lo vendido")).toBeNull()
    expect(screen.getByText("Un plato de menú no suma ingresos propios.", { exact: false })).toBeTruthy()
    expect(screen.getAllByText("Croquetas de la casa").length).toBeGreaterThan(0)
  })
  it("las fixtures de previsión reutilizan forecastDay y sus muestras", () => {
    const d = previsionEjemplo("2026-11-10", 14)
    expect(d.days).toHaveLength(14)
    expect(d.days[0]?.samples).toBe(12)
    expect(d.days[0]?.confidence).toBe("high")
    const none = forecastDay({ date: "2026-11-10", seats: 0, booked: { 780: 4 }, history: [] })
    expect(none.confidence).toBe("low")
    expect(none.slots[0]?.projected).toBe(4)
    expect(none.slots[0]?.occupancyBp).toBeNull()
  })
  it.each(["waiter", "kitchen", "bar"])("%s no monta consultas ni ve cifras", (role) => {
    mock.role = role
    render(<Analisis />)
    expect(screen.getByText(/Tu rol no puede ver el análisis/)).toBeTruthy()
    expect(screen.queryByText("Las cifras de tu sala")).toBeNull()
    mock.role = "owner"
  })
})
