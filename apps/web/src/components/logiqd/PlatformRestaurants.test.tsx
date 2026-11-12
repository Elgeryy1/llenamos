import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { provisionalPlanCatalog } from "@llenamos/core"

const mocks = vi.hoisted(() => ({ call: vi.fn(), mutate: vi.fn() }))
vi.mock("@/lib/data/callables", () => ({ llamarCore: mocks.call }))
vi.mock("@/lib/integraciones/acciones", () => ({ usePlatformMutation: () => ({ mutate: mocks.mutate, pending: false, error: null }) }))
const { PlatformRestaurants } = await import("./PlatformRestaurants")

describe("administración sin acceso operativo", () => {
  beforeEach(() => {
    mocks.mutate.mockReset().mockResolvedValue({ restaurantId: "new", locationId: "principal", invitationStatus: "pending" })
    mocks.call.mockReset().mockImplementation(async name => name === "listarPlanesDisponibles" ? { plans: provisionalPlanCatalog() } : { restaurants: [{ restaurantId: "panas", name: "Los Panas", slug: "los-panas", ownerEmail: "propietario@panas.test", planId: "sala", planVersion: 1, status: "active", activeModules: ["reservations"], moduleOverrides: {}, revision: 1 }], nextCursor: null })
  })
  it("consulta únicamente metadatos y no ofrece soporte ni entrada al restaurante", async () => {
    render(<PlatformRestaurants />)
    await screen.findByText("Los Panas")
    expect(mocks.call).toHaveBeenCalledWith("listarRestaurantesAdministracion", { cursor: null, limit: 25 })
    expect(mocks.call.mock.calls.some(([name]) => name === "listarRestaurantesLogiqd" || name === "verUsoPlataforma")).toBe(false)
    expect(screen.queryByText(/Soporte temporal/)).toBeNull()
    expect(screen.queryByRole("button", { name: /Entrar al restaurante/ })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Configurar plan y módulos" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Guardar plan y módulos" })).toBeTruthy())
    expect(screen.queryByRole("button", { name: /Abrir acceso/ })).toBeNull()
  })
  it("permite crear sin APIs y no anuncia una invitación que no se ha enviado", async () => {
    render(<PlatformRestaurants />)
    await screen.findByText("Los Panas")
    fireEvent.click(screen.getByRole("button", { name: "Dar de alta un restaurante" }))
    fireEvent.change(screen.getByLabelText("Restaurante"), { target: { value: "Los Nuevos Panas" } })
    fireEvent.change(screen.getByLabelText("Identificador público"), { target: { value: "nuevos-panas" } })
    fireEvent.change(screen.getByLabelText("Nombre del local"), { target: { value: "Principal" } })
    fireEvent.change(screen.getByLabelText("Nombre del propietario"), { target: { value: "Ana" } })
    fireEvent.change(screen.getByLabelText("Correo del propietario"), { target: { value: "ana@panas.test" } })
    for (const label of ["Clave secreta de Stripe", "Token de WhatsApp", "API de correo (Resend)", "API del proveedor de Verifactu", "API de Repite"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).required).toBe(false)
    }
    fireEvent.click(screen.getByRole("button", { name: "Crear restaurante" }))
    await screen.findByText(/La invitación está pendiente/)
    expect(mocks.mutate).toHaveBeenCalledWith("altaRestauranteLogiqd", expect.objectContaining({ name: "Los Nuevos Panas", ownerEmail: "ana@panas.test" }))
    expect(mocks.mutate.mock.calls[0]![1]).not.toHaveProperty("integrations")
    expect(screen.queryByText("Restaurante creado. Hemos enviado la invitación a su propietario.")).toBeNull()
  })
  it("muestra campos secretos vacíos y envía solo la credencial escrita", async () => {
    mocks.mutate.mockResolvedValue({ restaurant: {} })
    render(<PlatformRestaurants />)
    await screen.findByText("Los Panas")
    fireEvent.click(screen.getByRole("button", { name: "Configurar plan y módulos" }))
    const secret = screen.getByLabelText("Clave secreta de Stripe") as HTMLInputElement
    expect(secret.type).toBe("password"); expect(secret.value).toBe("")
    fireEvent.change(secret, { target: { value: "sk_test_written_now" } })
    fireEvent.change(screen.getByLabelText("Motivo del cambio"), { target: { value: "Configurar los pagos del restaurante" } })
    fireEvent.click(screen.getByRole("button", { name: "Guardar plan y módulos" }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledWith("configurarRestauranteLogiqd", expect.objectContaining({ integrations: { stripe: { secretKey: "sk_test_written_now" } } })))
  })
})
