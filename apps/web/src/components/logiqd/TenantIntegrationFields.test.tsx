import { render, screen, fireEvent } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { integrationChanges, TenantIntegrationFields } from "./TenantIntegrationFields"

describe("credenciales opcionales por restaurante", () => {
  it("no envía vacíos que puedan borrar secretos anteriores", () => {
    expect(integrationChanges({ stripe: { secretKey: "  " }, email: { apiKey: "" } }, [])).toEqual({})
    expect(integrationChanges({ stripe: { secretKey: " nueva-clave " }, email: {} }, [])).toEqual({ integrations: { stripe: { secretKey: "nueva-clave" } } })
  })
  it("una retirada explícita prevalece sobre una nueva clave del mismo proveedor", () => {
    expect(integrationChanges({ stripe: { secretKey: "nueva-clave" } }, ["stripe"])).toEqual({ removeIntegrations: ["stripe"] })
  })
  it("no confunde credenciales almacenadas con un adaptador operativo", () => {
    const remove = vi.fn()
    render(<TenantIntegrationFields values={{}} onChange={vi.fn()} statuses={{ fiscal: { configured: true, status: "adapter_pending" } }} removed={[]} onRemove={remove} disabled={false} />)
    expect(screen.getByText(/Credenciales guardadas; integración pendiente/)).toBeTruthy()
    expect((screen.getByLabelText("API del proveedor de Verifactu") as HTMLInputElement).value).toBe("")
    fireEvent.click(screen.getByLabelText("Eliminar las credenciales de Verifactu al guardar"))
    expect(remove).toHaveBeenCalledWith(["fiscal"])
  })
  it("permite retirar una configuración parcial aunque no esté completa", () => {
    const remove = vi.fn()
    render(<TenantIntegrationFields values={{}} onChange={vi.fn()} statuses={{ stripe: { configured: false, status: "not_configured" } }} removed={[]} onRemove={remove} disabled={false} />)
    fireEvent.click(screen.getByLabelText("Eliminar las credenciales de Stripe al guardar"))
    expect(remove).toHaveBeenCalledWith(["stripe"])
  })
})
