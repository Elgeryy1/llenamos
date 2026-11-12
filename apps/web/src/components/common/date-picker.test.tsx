import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DateInput } from "./date-picker"

describe("DateInput", () => {
  it("elige un día tras el cambio de hora sin desplazar la fecha y devuelve el foco", async () => {
    const change = vi.fn()
    render(<DateInput label="Día especial" value="2026-03-29" onChange={change} />)
    const trigger = screen.getByRole("button", { name: /Día especial:/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("button", { name: /30 de marzo de 2026/ }))
    expect(change).toHaveBeenCalledWith("2026-03-30")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it("limita el alta por min y permite borrar para que siga actuando la validación del formulario", () => {
    const change = vi.fn()
    render(<DateInput id="especial" label="Día especial" value="2026-11-09" min="2026-11-09" onChange={change} aria-invalid aria-describedby="error-fecha" />)
    const trigger = screen.getByRole("button", { name: /Día especial:/ })
    expect(trigger.id).toBe("especial")
    expect(trigger.getAttribute("aria-invalid")).toBe("true")
    expect(trigger.getAttribute("aria-describedby")).toBe("error-fecha")
    fireEvent.click(trigger)
    expect((screen.getByRole("button", { name: /^domingo, 8 de noviembre de 2026$/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Borrar fecha" }))
    expect(change).toHaveBeenCalledWith("")
  })

  it("empieza vacío sin convertir la ausencia en una fecha", () => {
    render(<DateInput label="Día nuevo" value="" onChange={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Día nuevo" }).textContent).toContain("Elige un día")
  })
})
