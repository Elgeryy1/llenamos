import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { TableDoc } from "@/lib/data/parse"
import { chairSpots, fitView, Plano, type PlanoLiveTable } from "./Plano"

const tables: TableDoc[] = [
  { id: "s1", name: "S1", areaId: "sala", seats: 2, shape: "rect", x: 6, y: 14, w: 12, h: 18, joinableWith: ["s2"], enabled: true },
  { id: "s2", name: "S2", areaId: "sala", seats: 4, shape: "round", x: 24, y: 14, w: 12, h: 18, joinableWith: [], enabled: false },
]

describe("Plano", () => {
  it("pone cada mesa en su sitio y la describe", () => {
    render(<Plano label="Sala" tables={tables} names={new Map([["s1", "S1"], ["s2", "S2"]])} />)
    const plano = screen.getByRole("list", { name: "Plano de Sala" })
    const items = within(plano).getAllByRole("listitem")
    expect(items).toHaveLength(2)

    const s1 = screen.getByRole("listitem", { name: "Mesa S1, 2 plazas, rectangular, se puede juntar con S2" })
    expect(s1.style.left).toBe("6%")
    expect(s1.style.top).toBe("14%")
    expect(s1.style.width).toBe("12%")
    expect(s1.className).toContain("rounded-lg")

    const s2 = screen.getByRole("listitem", { name: "Mesa S2, 4 plazas, redonda, deshabilitada" })
    expect(s2.className).toContain("rounded-full")
    expect(s2.className).toContain("border-dashed")
  })
})

describe("mesa dibujada", () => {
  it("pone tantas sillas como plazas, también en mesas largas con cabeceras", () => {
    expect(chairSpots("round", 4, true)).toHaveLength(4)
    expect(chairSpots("rect", 2, true)).toHaveLength(2)
    const eight = chairSpots("rect", 8, true)
    expect(eight).toHaveLength(8)
    // Dos cabeceras a media altura.
    expect(eight.filter((c) => c.style.top === "50%")).toHaveLength(2)
  })

  it("las sillas ocupadas son las de las personas sentadas", () => {
    const live = new Map<string, PlanoLiveTable>([["s1", { state: "seated", line: "Ana · 20 min", progress: 0.2, clickable: true, guest: "Ana", detail: "20′", party: 1 }]])
    const { container } = render(<Plano label="Sala" tables={[tables[0]!]} names={new Map()} live={live} onSelect={() => {}} />)
    const mesa = container.querySelector("[data-mesa-estado='seated']")!
    const sillas = mesa.querySelectorAll(":scope > span[aria-hidden]")
    expect(sillas).toHaveLength(2)
    expect(sillas[0]!.className).toContain("bg-success")
    expect(sillas[1]!.className).not.toContain("bg-success")
    expect(screen.getByRole("button", { name: /Mesa S1/ }).getAttribute("aria-pressed")).toBe("false")
  })

  it("el encuadre se acerca a las mesas sin moverlas", () => {
    const fit = fitView(tables)
    expect(fit.aspect).toBeGreaterThanOrEqual(1.5)
    expect(fit.aspect).toBeLessThanOrEqual(2.4)
    expect(parseFloat(String(fit.style.width))).toBeGreaterThan(100)
    expect(fitView([]).aspect).toBeCloseTo(1.6)
  })

  it("en una mesa redonda el texto va en la franja central, sin rozar el borde, y con la palabra del estado", () => {
    const live = new Map<string, PlanoLiveTable>([["s2", { state: "late", line: "Ana · 14:48", progress: 0, clickable: true, guest: "Ana", detail: "14:48" }]])
    const round = { ...tables[1]!, enabled: true }
    const { container } = render(<Plano label="Sala" tables={[round]} names={new Map()} live={live} onSelect={() => {}} compact />)
    const mesa = container.querySelector("[data-mesa-estado='late']")!
    const caja = mesa.querySelector("button > span")!
    expect(caja.className).toContain("px-[10%]")
    expect(caja.className).toContain("overflow-hidden")
    // Palabra larga y corta (la corta solo se ve si la mesa es pequeña); nunca solo color.
    expect(mesa.textContent).toContain("Va tarde")
    expect(mesa.textContent).toContain("Tarde")
  })
})

