import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fixtureOrigen } from "@/lib/campanas/fixtures"
const enviar = vi.hoisted(() => vi.fn())
vi.mock("@/components/panel/PanelContext", () => ({
  usePanel: () => ({ restaurant: { id: "r", name: "Lumbre", timezone: "Europe/Madrid" }, locations: [{ id: "centro", name: "Centro" }] }),
}))
vi.mock("@/lib/campanas/api", () => ({
  llamarMarketing: (...args: unknown[]) => enviar(...args),
  errorMarketing: () => "Falta el backend de origen",
}))
import { InformeOrigen, OrigenResultados } from "./InformeOrigen"

beforeEach(() => {
  enviar.mockReset()
})

describe("informe de origen", () => {
  it("distingue reservas antiguas sin origen de las de canal directo", () => {
    render(<OrigenResultados data={fixtureOrigen} />)
    expect(screen.getByText("No se atribuyen a directo")).toBeTruthy()
    expect(screen.queryByText("Directo", { exact: true })).toBeNull()
    expect(screen.getByText("Google Maps", { exact: true })).toBeTruthy()
  })
  it("consulta solo los locales accesibles y oculta una respuesta si cambió el filtro", async () => {
    let resolver!: (out: unknown) => void
    enviar.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolver = resolve
        }),
    )
    render(<InformeOrigen />)
    fireEvent.change(screen.getByLabelText("Desde el día"), { target: { value: "2026-10-01" } })
    fireEvent.change(screen.getByLabelText("Hasta el día"), { target: { value: "2026-10-31" } })
    fireEvent.click(screen.getByRole("button", { name: "Ver informe" }))
    await waitFor(() =>
      expect(enviar).toHaveBeenCalledWith("informeOrigen", {
        restaurantId: "r",
        from: "2026-10-01",
        to: "2026-10-31",
        locationIds: ["centro"],
      }),
    )
    fireEvent.change(screen.getByLabelText("Hasta el día"), { target: { value: "2026-11-01" } })
    await act(async () => resolver(fixtureOrigen))
    expect(screen.queryByText("Reservas con origen")).toBeNull()
  })
})
