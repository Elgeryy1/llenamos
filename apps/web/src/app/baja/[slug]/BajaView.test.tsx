import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
const enviar = vi.hoisted(() => vi.fn())
vi.mock("@/lib/campanas/api", () => ({ llamarMarketing: enviar }))
import { BajaView, RESPUESTA_BAJA } from "./BajaView"

beforeEach(() => {
  enviar.mockReset()
})
describe("baja pública", () => {
  it.each(["a".repeat(43), "b".repeat(43), "roto"])("responde igual sin descubrir si existe el token %s", async (token) => {
    enviar.mockResolvedValue({ ok: true })
    render(<BajaView slug="lumbre" token={token} />)
    expect(enviar).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Dar de baja este canal" }))
    await waitFor(() => expect(screen.getByText(RESPUESTA_BAJA)).toBeTruthy())
    expect(screen.queryByText(token)).toBeNull()
  })
  it("un fallo de red no simula una baja atendida", async () => {
    enviar.mockRejectedValue(new Error("Sin backend"))
    render(<BajaView slug="lumbre" token={"a".repeat(43)} />)
    fireEvent.click(screen.getByRole("button", { name: "Dar de baja este canal" }))
    await waitFor(() => expect(screen.getByText("No hemos podido confirmar la baja")).toBeTruthy())
    expect(screen.queryByText(RESPUESTA_BAJA)).toBeNull()
  })
})
