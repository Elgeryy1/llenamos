import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Role } from "@llenamos/core"
import { fixtureCampanas, fixtureSegmentos, fixtureSimulacion } from "@/lib/campanas/fixtures"
const state = vi.hoisted(() => ({ role: "owner" as Role, enviar: vi.fn(), success: vi.fn() }))
vi.mock("@/components/panel/PanelContext", () => ({
  usePanel: () => ({
    restaurant: { id: "r", name: "Lumbre", timezone: "Europe/Madrid", activeModules: ["marketing"] },
    role: state.role,
    locations: [{ id: "centro", name: "Centro" }],
  }),
}))
vi.mock("next/navigation", () => ({ usePathname: () => "/panel/campanas" }))
vi.mock("@/lib/firebase/client", () => ({ getFirebase: () => ({ functions: {} }) }))
vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: { options: { projectId: "demo-llenamos" }, region: "europe-west1", emulators: { host: "127.0.0.1", ports: { functions: 5001 } } } } }))
vi.mock("firebase/functions", () => ({ httpsCallable: (_f: unknown, name: string) => (input: unknown) => state.enviar(name, input) }))
vi.mock("sonner", () => ({ toast: { success: state.success } }))
import { CampanaDetalle } from "./CampanaDetalle"
import { CampanaEditor } from "./CampanaEditor"
import { MarcoCampanas } from "./MarcoCampanas"

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

beforeEach(() => {
  state.role = "owner"
  state.enviar.mockReset()
  state.success.mockReset()
})
const abrir = () => render(<CampanaDetalle actual={fixtureCampanas[0]!} onClose={vi.fn()} onEdit={vi.fn()} />)

describe("campañas con permisos y backend", () => {
  it("el encargado prepara y simula, pero no ve Lanzar", () => {
    state.role = "manager"
    abrir()
    expect(screen.queryByRole("button", { name: "Lanzar campaña" })).toBeNull()
    expect(screen.getByRole("button", { name: "Simular campaña" })).toBeTruthy()
  })
  it.each(["waiter", "kitchen", "bar"] as const)("%s no monta campañas", (role) => {
    state.role = role
    render(
      <MarcoCampanas>
        <p>contenido privado</p>
      </MarcoCampanas>,
    )
    expect(screen.queryByText("contenido privado")).toBeNull()
  })
  it("WhatsApp sin verificar dice que la campaña no saldrá", () => {
    render(<CampanaDetalle actual={fixtureCampanas[1]!} onClose={vi.fn()} onEdit={vi.fn()} />)
    expect(screen.getByText(/Esta campaña por WhatsApp no saldrá/)).toBeTruthy()
  })
  it("exige simular y confirmar antes de programar con revisión e idempotencia", async () => {
    state.enviar.mockImplementation((name) =>
      Promise.resolve({
        data:
          name === "simularCampana" ? fixtureSimulacion : { revision: 2, status: "scheduled", scheduledAt: fixtureSimulacion.firstSendAt },
      }),
    )
    abrir()
    expect(screen.getByRole("button", { name: "Lanzar campaña" })).toHaveProperty("disabled", true)
    fireEvent.click(screen.getByRole("button", { name: "Simular campaña" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Lanzar campaña" })).toHaveProperty("disabled", false))
    fireEvent.click(screen.getByRole("button", { name: "Lanzar campaña" }))
    expect(state.enviar.mock.calls.filter((c) => c[0] === "lanzarCampana")).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Confirmar programación" }))
    await waitFor(() => expect(state.success).toHaveBeenCalled())
    expect(state.enviar.mock.calls.find((c) => c[0] === "lanzarCampana")?.[1]).toMatchObject({
      restaurantId: "r",
      campaignId: "fixture_otono",
      expectedRevision: 1,
      at: null,
      requestId: expect.any(String),
    })
  })
  it("una respuesta pendiente deja sin efecto la simulación tras cambiar la revisión", async () => {
    let resolver!: (value: unknown) => void
    state.enviar.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolver = resolve
        }),
    )
    const { rerender } = abrir()
    fireEvent.click(screen.getByRole("button", { name: "Simular campaña" }))
    await waitFor(() => expect(state.enviar).toHaveBeenCalled())
    rerender(<CampanaDetalle actual={{ ...fixtureCampanas[0]!, revision: 2 }} onClose={vi.fn()} onEdit={vi.fn()} />)
    await act(async () => resolver({ data: fixtureSimulacion }))
    expect(screen.getByRole("button", { name: "Lanzar campaña" })).toHaveProperty("disabled", true)
  })
  it("no programa si cambia la revisión mientras la confirmación está abierta", async () => {
    state.enviar.mockResolvedValue({ data: fixtureSimulacion })
    const { rerender } = abrir()
    fireEvent.click(screen.getByRole("button", { name: "Simular campaña" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Lanzar campaña" })).toHaveProperty("disabled", false))
    fireEvent.click(screen.getByRole("button", { name: "Lanzar campaña" }))
    rerender(<CampanaDetalle actual={{ ...fixtureCampanas[0]!, revision: 2 }} onClose={vi.fn()} onEdit={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "Confirmar programación" }))
    await waitFor(() => expect(screen.getByText(/La campaña ha cambiado/)).toBeTruthy())
    expect(state.enviar.mock.calls.some((c) => c[0] === "lanzarCampana")).toBe(false)
  })
  it("si falta el backend de guardado, no muestra éxito ni cierra el borrador", async () => {
    state.enviar.mockRejectedValue(Object.assign(new Error("NOT FOUND"), { code: "functions/not-found" }))
    const close = vi.fn()
    render(<CampanaEditor actual={fixtureCampanas[0]!} segmentos={fixtureSegmentos} onClose={close} />)
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }))
    await waitFor(() => expect(screen.getByText(/El servicio de campañas no está disponible/)).toBeTruthy())
    expect(close).not.toHaveBeenCalled()
    expect(state.success).not.toHaveBeenCalled()
  })
})
