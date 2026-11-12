import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { filterCommands } from "@/components/panel/command/commands"
import { keyOf } from "@/components/panel/command/hotkeys"
import type { AreaDoc, TableDoc } from "@/lib/data/parse"
import { groupByShift } from "@/lib/reservas/dia"
import { at, config, reservation } from "@/lib/reservas/fixtures"
import { Timeline, timelineRange } from "./Timeline"

const DAY = "2026-11-10"
const areas: AreaDoc[] = [{ id: "sala", name: "Sala", sortOrder: 0 }]
const tables: TableDoc[] = [
  { id: "s1", name: "S1", areaId: "sala", seats: 2, shape: "rect", x: 6, y: 14, w: 12, h: 18, joinableWith: [], enabled: true },
  { id: "s2", name: "S2", areaId: "sala", seats: 4, shape: "round", x: 24, y: 14, w: 12, h: 18, joinableWith: [], enabled: true },
]
const names = new Map([
  ["s1", "S1"],
  ["s2", "S2"],
])

describe("línea de tiempo del día", () => {
  const c = config()
  const list = [
    reservation({ guestName: "Pau Ferrer", tableIds: ["s1"], startAt: at(DAY, "21:00"), status: "seated" }),
    reservation({ guestName: "Núria Bosch", tableIds: [], startAt: at(DAY, "21:30"), partySize: 4 }),
    reservation({ guestName: "Anulada", tableIds: ["s2"], startAt: at(DAY, "20:30"), status: "cancelled" }),
  ]
  const groups = groupByShift(list, c, DAY).filter((g) => g.shift.index >= 0)

  it("abarca el turno en horas en punto", () => {
    const range = timelineRange(groups, c, DAY)!
    expect(range.from).toBe(at(DAY, "20:00"))
    expect(range.to).toBeGreaterThanOrEqual(at(DAY, "22:30"))
    expect((range.to - range.from) % 3_600_000).toBe(0)
  })

  it("cada reserva es un botón que dice quién, cuándo, dónde y su estado; las canceladas no salen", () => {
    const onOpen = vi.fn()
    render(
      <TooltipProvider>
        <Timeline
          groups={groups}
          config={c}
          day={DAY}
          now={at(DAY, "21:40")}
          areas={areas}
          tables={tables}
          tableNames={names}
          matches={() => true}
          selectedId={null}
          onOpen={onOpen}
        />
      </TooltipProvider>,
    )
    const pau = screen.getByRole("button", { name: /Pau Ferrer, 2 personas, de 21:00 a 22:30, mesa S1, sentada/ })
    fireEvent.click(pau)
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ guestName: "Pau Ferrer" }))
    expect(screen.getByRole("button", { name: /Núria Bosch.*sin mesa/ })).toBeTruthy()
    expect(screen.getByText("Por asignar")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Anulada/ })).toBeNull()
  })

  it("alarga hasta ahora a quien sigue sentado y separa las reservas de la misma mesa que se pisan", () => {
    const now = at(DAY, "23:45")
    const ocupada = reservation({ guestName: "Sigue sentado", tableIds: ["s1"], startAt: at(DAY, "20:00"), status: "seated" })
    const siguiente = reservation({ guestName: "Siguiente", tableIds: ["s1"], startAt: at(DAY, "22:00") })
    const soloSentada = groupByShift([ocupada], c, DAY)
    expect(timelineRange(soloSentada, c, DAY, at("2026-11-11", "01:10"))?.to).toBe(at("2026-11-11", "02:00"))
    render(
      <TooltipProvider>
        <Timeline groups={groupByShift([ocupada, siguiente], c, DAY)} config={c} day={DAY} now={now}
          areas={areas} tables={tables} tableNames={names} matches={() => true} selectedId={null} onOpen={() => {}} />
      </TooltipProvider>,
    )
    const primera = screen.getByRole("button", { name: /Sigue sentado/ })
    const segunda = screen.getByRole("button", { name: /Siguiente/ })
    expect(primera.style.top).not.toBe(segunda.style.top)
    expect(primera.getAttribute("aria-label")).toContain("pasan de su hora")
  })
})

describe("atajos de teclado", () => {
  it("normaliza las teclas", () => {
    expect(keyOf(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))).toBe("mod+k")
    expect(keyOf(new KeyboardEvent("keydown", { key: "K", metaKey: true }))).toBe("mod+k")
    expect(keyOf(new KeyboardEvent("keydown", { key: "?", shiftKey: true }))).toBe("?")
    expect(keyOf(new KeyboardEvent("keydown", { key: "ArrowLeft" }))).toBe("arrowleft")
  })
})

describe("búsqueda de la paleta", () => {
  it("ignora acentos, prefiere el principio y no acepta letras sueltas", () => {
    expect(filterCommands("x", "ivan", ["Iván Prieto"])).toBe(1)
    expect(filterCommands("x", "prieto", ["Iván Prieto"])).toBe(0.8)
    expect(filterCommands("x", "ivan", ["Andrea Lozano"])).toBe(0)
    expect(filterCommands("x", "610 10", ["Iván Prieto", "+34610102947"])).toBeGreaterThan(0)
  })
})
