import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TimeSelectField } from "./time-select-field"

afterEach(() => Reflect.deleteProperty(Element.prototype, "scrollIntoView"))

describe("TimeSelectField", () => {
  it("conserva la hora actual entre franjas y permite elegir por teclado otro cuarto de hora", () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() })
    const change = vi.fn()
    render(<TimeSelectField label="Hora" value="13:07" onChange={change} />)
    const trigger = screen.getByRole("combobox", { name: "Hora" })
    expect(trigger.textContent).toContain("13:07")
    fireEvent.keyDown(trigger, { key: "Enter" })
    expect(screen.getAllByRole("option")).toHaveLength(97)
    expect(screen.getByRole("option", { name: "00:00" })).toBeTruthy()
    expect(screen.getByRole("option", { name: "23:45" })).toBeTruthy()
    fireEvent.click(screen.getByRole("option", { name: "13:15" }))
    expect(change).toHaveBeenCalledWith("13:15")
  })

  it("enlaza el error al control sin perder la hora elegida", () => {
    render(<TimeSelectField label="Hora" value="20:00" onChange={vi.fn()} error="Elige otra hora." />)
    const trigger = screen.getByRole("combobox", { name: "Hora" })
    expect(trigger.getAttribute("aria-invalid")).toBe("true")
    expect(document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent).toBe("Elige otra hora.")
    expect(trigger.textContent).toContain("20:00")
  })
})
