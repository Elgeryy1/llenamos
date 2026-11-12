import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { PublicMarketingOptInSchema } from "@llenamos/core"
import { CasillasPermiso, permisoInicial } from "./CasillasPermiso"

function Formulario() {
  const [value, setValue] = useState(permisoInicial("2026.11"))
  return (
    <>
      <CasillasPermiso policyVersion="2026.11" policyUrl="/privacidad" value={value} onChange={setValue} />
      <output>{JSON.stringify(value)}</output>
    </>
  )
}
describe("permiso al reservar", () => {
  it("empieza desmarcado y marca cada canal por separado con la versión", () => {
    render(<Formulario />)
    const boxes = screen.getAllByRole("checkbox")
    expect(boxes.every((b) => b.getAttribute("aria-checked") === "false")).toBe(true)
    fireEvent.click(boxes[0]!)
    const value = JSON.parse(screen.getByRole("status").textContent!)
    expect(PublicMarketingOptInSchema.parse(value)).toEqual({ email: true, whatsapp: false, policyVersion: "2026.11" })
    expect(boxes[1]!.getAttribute("aria-checked")).toBe("false")
  })
  it("no reutiliza permiso si cambia la política y avisa al formulario dueño", async () => {
    const change = vi.fn()
    render(
      <CasillasPermiso
        policyVersion="nueva"
        policyUrl="/privacidad"
        value={{ email: true, whatsapp: true, policyVersion: "antigua" }}
        onChange={change}
      />,
    )
    expect(screen.getAllByRole("checkbox").every((b) => b.getAttribute("aria-checked") === "false")).toBe(true)
    await waitFor(() => expect(change).toHaveBeenCalledWith(permisoInicial("nueva")))
  })
})
