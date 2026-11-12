import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({ llamar: vi.fn() }))
vi.mock("@/lib/personal/api", () => ({ llamarPersonal: api.llamar, errorPersonal: (e: Error) => e.message }))
import { ExportarRegistro } from "./ExportarRegistro"

const scope = { restaurantId: "r", locationId: "l" }
const respuesta = { uid: "ana-9f3c2d1e77", generatedAt: Date.UTC(2026, 10, 12), retentionYears: 4, entries: [{ id: "e1" }], events: [] }

describe("descarga del registro de jornada", () => {
  beforeEach(() => {
    api.llamar.mockReset()
    URL.createObjectURL = vi.fn(() => "blob:x")
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

  it("en la demo no se ofrece", () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "firebase-demo")
    const { container } = render(<ExportarRegistro scope={scope} uid={null} />)
    expect(container.innerHTML).toBe("")
  })

  it("en el VPS pide el registro propio, explica la conservación y entrega el archivo", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    api.llamar.mockResolvedValue(respuesta)
    render(<ExportarRegistro scope={scope} uid={null} />)
    expect(screen.getByText(/se conserva 4 años por obligación legal/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Descargar mi registro de jornada/ }))
    await waitFor(() => expect(screen.getByText(/registro-de-jornada-ana9f3c2-2026-11-12.json con 1 fichaje\b/)).toBeTruthy())
    expect(api.llamar).toHaveBeenCalledWith("exportarMisFichajes", { ...scope, uid: null })
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it("al encargado le habla de la copia de la persona y concuerda el plural", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    api.llamar.mockResolvedValue({ ...respuesta, entries: [{ id: "a" }, { id: "b" }] })
    render(<ExportarRegistro scope={scope} uid="ana-9f3c2d1e77" />)
    expect(screen.getByText(/A petición de la persona, puedes descargar su copia/)).toBeTruthy()
    expect(screen.queryByText(/descargar tu copia/)).toBeNull()
    fireEvent.click(screen.getByRole("button"))
    await waitFor(() => expect(screen.getByText(/con 2 fichajes/)).toBeTruthy())
  })

  it("un fallo se enseña y no se descarga nada", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    api.llamar.mockRejectedValue(new Error("Hay demasiados registros"))
    render(<ExportarRegistro scope={scope} uid="ana" etiqueta="Descargar el registro de Ana" />)
    fireEvent.click(screen.getByRole("button", { name: "Descargar el registro de Ana" }))
    await waitFor(() => expect(screen.getByText("Hay demasiados registros")).toBeTruthy())
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
