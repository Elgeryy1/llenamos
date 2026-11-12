import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const llamarCore = vi.fn()
vi.mock("@/lib/data/callables", () => ({ llamarCore: (...a: unknown[]) => llamarCore(...a) }))
const panel = vi.hoisted(() => ({ role: "owner" as string }))
vi.mock("@/components/panel/PanelContext", () => ({ usePanel: () => ({ restaurant: { id: "r1" }, role: panel.role }) }))
import { ProveedoresRestaurante } from "./ProveedoresRestaurante"
import { cambiosDeFormulario, PROVEEDORES, urlWebhook } from "@/lib/proveedores/campos"

const providers = Object.fromEntries(["stripe", "whatsapp", "email", "fiscal", "repite"].map((p) => [p, { configured: false, status: "not_configured" }]))
const vacio = { providers, savedFields: { stripe: [], whatsapp: [], email: [], fiscal: [], repite: [] } }

beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres"); llamarCore.mockReset(); panel.role = "owner" })
afterEach(() => vi.unstubAllEnvs())

describe("proveedores del restaurante", () => {
  it("el encargado no ve la sección y no se pide nada", () => {
    panel.role = "manager"
    const { container } = render(<ProveedoresRestaurante />)
    expect(container.innerHTML).toBe("")
    expect(llamarCore).not.toHaveBeenCalled()
  })

  it("en la demo no se ofrece", () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "firebase-demo")
    const { container } = render(<ProveedoresRestaurante />)
    expect(container.innerHTML).toBe("")
  })

  it("guarda solo lo escrito, con campos de contraseña, y el valor no se queda en pantalla", async () => {
    llamarCore.mockImplementation(async (name: string) => name === "verProveedoresRestaurante" ? vacio
      : { providers: { ...providers, email: { configured: true, status: "configured" } }, savedFields: { ...vacio.savedFields, email: ["apiKey", "from"] } })
    render(<ProveedoresRestaurante />)
    const clave = await screen.findByLabelText("Clave de la API", { selector: "input[name='email-apiKey']" })
    expect(clave.getAttribute("type")).toBe("password")
    fireEvent.change(clave, { target: { value: "re_secreta" } })
    fireEvent.change(screen.getByLabelText("Remitente"), { target: { value: "Casa <hola@casa.test>" } })
    const botones = screen.getAllByRole("button", { name: "Guardar" })
    fireEvent.click(botones[2]!)
    await waitFor(() => expect(llamarCore).toHaveBeenCalledWith("guardarProveedoresRestaurante", { restaurantId: "r1", integrations: { email: { apiKey: "re_secreta", from: "Casa <hola@casa.test>" } }, remove: [], clear: [] }))
    await waitFor(() => expect((screen.getByLabelText("Clave de la API", { selector: "input[name='email-apiKey']" }) as HTMLInputElement).value).toBe(""))
    expect(screen.getAllByText("Configurado").length).toBe(1)
    expect(screen.queryByDisplayValue("re_secreta")).toBeNull()
  })

  it("quitar pide confirmación y manda el proveedor en remove", async () => {
    const guardado = { providers: { ...providers, stripe: { configured: true, status: "adapter_pending" } }, savedFields: { ...vacio.savedFields, stripe: ["secretKey", "webhookSecret"] } }
    llamarCore.mockImplementation(async (name: string) => name === "verProveedoresRestaurante" ? guardado : vacio)
    render(<ProveedoresRestaurante />)
    await screen.findByText("Guardado, aún sin conexión activa")
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }))
    expect(llamarCore).not.toHaveBeenCalledWith("guardarProveedoresRestaurante", expect.anything())
    fireEvent.click(screen.getByRole("button", { name: "Sí, quitar Stripe" }))
    await waitFor(() => expect(llamarCore).toHaveBeenCalledWith("guardarProveedoresRestaurante", { restaurantId: "r1", integrations: {}, remove: ["stripe"], clear: [] }))
  })

  it("un fallo del servidor se enseña", async () => {
    llamarCore.mockImplementation(async (name: string) => { if (name === "verProveedoresRestaurante") return vacio; throw Object.assign(new Error("custodia"), { code: "failed-precondition" }) })
    render(<ProveedoresRestaurante />)
    fireEvent.change(await screen.findByLabelText("Clave de la API", { selector: "input[name='repite-apiKey']" }), { target: { value: "x" } })
    fireEvent.click(screen.getAllByRole("button", { name: "Guardar" })[4]!)
    expect(await screen.findByText("No se ha podido guardar")).not.toBeNull()
  })
})

describe("validación y campos opcionales", () => {
  it("avisa del formato antes de enviar nada", async () => {
    llamarCore.mockImplementation(async () => vacio)
    render(<ProveedoresRestaurante />)
    fireEvent.change(await screen.findByLabelText("Clave secreta"), { target: { value: "no-es-una-clave" } })
    fireEvent.click(screen.getAllByRole("button", { name: "Guardar" })[0]!)
    expect(await screen.findByText("La clave secreta de Stripe empieza por sk_ o rk_.")).not.toBeNull()
    expect(llamarCore).not.toHaveBeenCalledWith("guardarProveedoresRestaurante", expect.anything())
  })

  it("un campo opcional guardado se puede vaciar sin quitar el proveedor", async () => {
    const guardado = { providers: { ...providers, stripe: { configured: true, status: "adapter_pending" } }, savedFields: { ...vacio.savedFields, stripe: ["secretKey", "webhookSecret", "accountId"] } }
    llamarCore.mockImplementation(async (name: string) => name === "verProveedoresRestaurante" ? guardado : vacio)
    render(<ProveedoresRestaurante />)
    fireEvent.click(await screen.findByRole("button", { name: "Vaciar Identificador de la cuenta" }))
    await waitFor(() => expect(llamarCore).toHaveBeenCalledWith("guardarProveedoresRestaurante", { restaurantId: "r1", integrations: {}, remove: [], clear: [{ provider: "stripe", field: "accountId" }] }))
    expect(screen.queryByRole("button", { name: "Vaciar Clave secreta" })).toBeNull()
  })
})

describe("campos de proveedores", () => {
  it("un formulario vacío no cambia nada y los espacios no cuentan", () => {
    const stripe = PROVEEDORES[0]!
    expect(cambiosDeFormulario(stripe, { secretKey: "   " })).toEqual({})
    expect(cambiosDeFormulario(stripe, { secretKey: " sk_x " })).toEqual({ stripe: { secretKey: "sk_x" } })
  })
  it("la dirección del webhook lleva el restaurante", () => {
    expect(urlWebhook("https://app.test", "stripe", "r1")).toBe("https://app.test/api/v1/webhooks/stripe/r1")
  })
})
