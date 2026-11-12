import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { OperacionCaja } from "@/lib/caja/useOperacion"

const { panel, horas } = vi.hoisted(() => ({ panel: vi.fn(), horas: vi.fn() }))
vi.mock("@/components/panel/PanelContext", () => ({ usePanel: panel }))
vi.mock("@/lib/personal/datos", () => ({ useHorasParaPropinas: horas }))
vi.mock("@/lib/caja/datos", () => ({
  useEquipoCaja: () => ({
    status: "ready", fresh: true,
    data: [
      { id: "diego", displayName: "Diego Ríos" },
      { id: "nora", displayName: "Nora Costa" },
      { id: "lucia", displayName: "Lucía Ferrer" },
    ],
  }),
  useRepartos: () => ({ status: "ready", fresh: true, data: [] }),
  useMovimientos: vi.fn(), usePagos: vi.fn(),
}))
import { Propinas } from "./Turno"

const scope = { restaurantId: "demo-lumbre", locationId: "centro" }
const como = (modules: string[]) => panel.mockReturnValue({ role: "manager", restaurant: { id: "demo-lumbre", plan: "completo", activeModules: modules } })
function operacion() {
  return {
    run: vi.fn().mockResolvedValue({ shares: [] }),
    retry: vi.fn(), busy: false, blocked: false, pending: false, error: null, message: null, result: null, pendingName: undefined,
  } as unknown as OperacionCaja
}

beforeEach(() => vi.clearAllMocks())

describe("reparto de propinas con las horas fichadas", () => {
  it("sin módulo de personal no pide horas y deja el reparto manual", () => {
    como(["pos", "floor"])
    horas.mockReturnValue({ status: "off" })
    render(<Propinas scope={scope} sessionId="caja" op={operacion()} />)
    expect(horas).toHaveBeenCalledWith(scope, "caja", false)
    expect(screen.getByText(/no tiene el módulo de personal/)).toBeTruthy()
    expect((screen.getByLabelText("Diego Ríos · minutos aprobados") as HTMLInputElement).value).toBe("0")
  })

  it("con fichajes precarga los minutos y los envía tal cual, sin los de cero", async () => {
    como(["pos", "staff"])
    horas.mockReturnValue({ status: "ready", data: { hours: [{ uid: "diego", minutes: 240 }, { uid: "nora", minutes: 180 }], incomplete: [], windowStart: 1, windowEnd: 2 } })
    const op = operacion()
    render(<Propinas scope={scope} sessionId="caja" op={op} />)
    expect(horas).toHaveBeenCalledWith(scope, "caja", true)
    expect(screen.getByText(/vienen de lo fichado/)).toBeTruthy()
    expect((screen.getByLabelText("Diego Ríos · minutos aprobados") as HTMLInputElement).value).toBe("240")
    // El encargado puede cambiar lo precargado.
    fireEvent.change(screen.getByLabelText("Nora Costa · minutos aprobados"), { target: { value: "200" } })
    fireEvent.click(screen.getByRole("button", { name: "Confirmar reparto por minutos" }))
    await waitFor(() => expect(op.run).toHaveBeenCalled())
    expect(op.run).toHaveBeenCalledWith(
      "repartirPropinas",
      { cashSessionId: "caja", hours: [{ uid: "diego", minutes: 240 }, { uid: "nora", minutes: 200 }] },
      expect.any(Function),
    )
  })

  it("avisa de los fichajes olvidados, que no cuentan hasta que un encargado los cierre", () => {
    como(["pos", "staff"])
    horas.mockReturnValue({ status: "ready", data: { hours: [{ uid: "diego", minutes: 60 }], incomplete: ["lucia"], windowStart: 1, windowEnd: 2 } })
    render(<Propinas scope={scope} sessionId="caja" op={operacion()} />)
    expect(screen.getByText("Hay fichajes olvidados sin cerrar")).toBeTruthy()
    expect(screen.getByText(/Lucía Ferrer: su fichaje quedó abierto/)).toBeTruthy()
  })

  it("si nadie fichó en esa caja lo dice y deja los minutos a mano", () => {
    como(["pos", "staff"])
    horas.mockReturnValue({ status: "ready", data: { hours: [], incomplete: [], windowStart: 1, windowEnd: 2 } })
    render(<Propinas scope={scope} sessionId="caja" op={operacion()} />)
    expect(screen.getByText("No hay fichajes en esta caja")).toBeTruthy()
    expect((screen.getByLabelText("Diego Ríos · minutos aprobados") as HTMLInputElement).value).toBe("0")
  })

  it("si falla la lectura de horas lo cuenta y no bloquea el reparto manual", () => {
    como(["pos", "staff"])
    horas.mockReturnValue({ status: "error", message: "Falta el servidor de esta función." })
    render(<Propinas scope={scope} sessionId="caja" op={operacion()} />)
    expect(screen.getByText("No se han podido leer las horas fichadas")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Confirmar reparto por minutos" }) as HTMLButtonElement).disabled).toBe(false)
  })
})
