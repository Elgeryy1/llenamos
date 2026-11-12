import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ llamar: vi.fn(), settings: vi.fn(), dia: vi.fn(), panel: vi.fn() }))
vi.mock("@/components/panel/PanelContext", () => ({ usePanel: mocks.panel }))
vi.mock("@/lib/comandero/callables", () => ({ llamarSala: mocks.llamar, errorSala: (e: Error) => e.message }))
vi.mock("@/lib/comandero/datos", () => ({ rutaLocal: () => "", useDestino: () => ({ lines: { status: "ready", data: [] }, orders: { status: "ready", data: [] } }) }))
vi.mock("@/lib/data/hooks", () => ({
  useSala: () => ({ status: "ready", data: { tables: [{ id: "t1", name: "Mesa 1", seats: 4, enabled: true }, { id: "t2", name: "Mesa 2", seats: 4, enabled: true }], areas: [] } }),
  useMembers: () => ({ status: "ready", data: [] }),
}))
// El desplegable de la interfaz es un Radix Select; aquí basta uno nativo con la misma interfaz.
vi.mock("@/components/common/desplegable", () => ({ Desplegable: ({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props}>{children}</select> }))
vi.mock("@/lib/data/reservas", () => ({ useReservationSettings: mocks.settings, useDayReservations: mocks.dia }))
vi.mock("@/lib/reservas/hooks", () => ({ useNow: () => Date.UTC(2026, 10, 12, 12, 0) }))
import { AbrirMesa } from "./GestionMesa"

const reserva = (id: string, over: object = {}) => ({ id, guestName: `Cliente ${id}`, partySize: 3, tableIds: ["t2"], status: "confirmed", startAt: Date.UTC(2026, 10, 12, 19, 0), ...over })
const scope = { restaurantId: "r", locationId: "l" }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.panel.mockReturnValue({ role: "manager", restaurant: { id: "r", plan: "sala", timezone: "Europe/Madrid", activeModules: ["reservations", "floor"] } })
  mocks.settings.mockReturnValue({ status: "ready", data: { config: { zonaHoraria: "Europe/Madrid" } } })
  mocks.llamar.mockResolvedValue({ sessionId: "s1", joinable: true, reservationSeated: true })
})

it("sienta una reserva del día desde sala con las lecturas de reservas (la ruta de API de esas lecturas se prueba en lib/data)", async () => {
  mocks.dia.mockReturnValue({ status: "ready", data: [reserva("a"), reserva("b", { status: "cancelled" }), reserva("c", { startAt: Date.UTC(2026, 10, 14, 19, 0) })] })
  const onOpened = vi.fn()
  render(<AbrirMesa scope={scope} onOpened={onOpened} />)
  expect(mocks.settings).toHaveBeenCalledWith("r", "l", "Europe/Madrid", true)
  // Solo reservas vivas y de hoy.
  expect(screen.queryByText(/Cliente b/)).toBeNull(); expect(screen.queryByText(/Cliente c/)).toBeNull()
  fireEvent.change(screen.getByLabelText("Reserva"), { target: { value: "a" } })
  fireEvent.click(screen.getByRole("button", { name: /abrir mesa/i }))
  await waitFor(() => expect(mocks.llamar).toHaveBeenCalledWith("abrirMesa", expect.objectContaining({ ...scope, reservationId: "a", tableIds: ["t2"], guests: 3, guest: null })))
  await waitFor(() => expect(onOpened).toHaveBeenCalledWith("s1", null))
})
it("sin permiso de reservas no pide ni enseña reservas", () => {
  mocks.panel.mockReturnValue({ role: "kitchen", restaurant: { id: "r", plan: "sala", timezone: "Europe/Madrid", activeModules: ["reservations", "floor"] } })
  mocks.dia.mockReturnValue({ status: "loading" })
  render(<AbrirMesa scope={scope} onOpened={vi.fn()} />)
  expect(screen.queryByLabelText("Reserva")).toBeNull()
  expect(mocks.settings).toHaveBeenCalledWith("r", "l", "Europe/Madrid", false)
  expect(mocks.dia).toHaveBeenCalledWith("r", null, "2026-11-12", expect.anything())
})
it("si fallan los ajustes de reservas lo dice en vez de quedarse cargando", () => {
  mocks.settings.mockReturnValue({ status: "error", error: new Error("sin ajustes") })
  mocks.dia.mockReturnValue({ status: "loading" })
  render(<AbrirMesa scope={scope} onOpened={vi.fn()} />)
  expect(screen.getByRole("alert")).toBeTruthy()
})
