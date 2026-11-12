import { fireEvent, render, screen } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { stationTickets } from "@llenamos/core"
// Datos de ejemplo compartidos de core, exclusivamente para estas pruebas.
import { linea, T0 } from "../../../../../packages/core/src/sala/datos-prueba"
import { Ticket } from "./Ticket"

function renderTicket(status: "held" | "fired" | "preparing" | "ready", disabled = false) {
  const line = { id: "l1", ...linea({ status, notes: "Sin sal", variant: { id: "grande", name: { es: "Ración grande", ca: "", en: "" }, priceCents: 800 } }) }
  const ticket = stationTickets([line], "cocina", T0 + 12 * 60_000, 3)[0]!
  const onChange = vi.fn()
  render(<Ticket ticket={ticket} now={T0 + 12 * 60_000} pickupMinutes={3} timezone="Europe/Madrid" disabled={disabled} onChange={onChange} />)
  return { onChange, line }
}

it("presenta destino, pase, nota, variante y retraso legibles", () => {
  renderTicket("fired")
  expect(screen.getByRole("heading", { name: "S3" })).toBeTruthy()
  expect(screen.getByRole("heading", { name: "Primeros" })).toBeTruthy()
  expect(screen.getByText("Sin sal")).toBeTruthy()
  expect(screen.getByText("Ración grande")).toBeTruthy()
  expect(screen.getByText("Retraso 2 min")).toBeTruthy()
})
it("empezar, listo y deshacer usan la línea exacta", () => {
  const { onChange, line } = renderTicket("preparing")
  fireEvent.click(screen.getByRole("button", { name: "Listo" }))
  expect(onChange).toHaveBeenLastCalledWith(line, "ready")
  fireEvent.click(screen.getByRole("button", { name: "Deshacer inicio" }))
  expect(onChange).toHaveBeenLastCalledWith(line, "fired")
})
it("una línea retenida no ofrece acciones de preparación", () => {
  renderTicket("held")
  expect(screen.queryByRole("button", { name: "Empezar" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Listo" })).toBeNull()
  expect(screen.getByText("Espera a sala")).toBeTruthy()
})
it("volver a preparar deshace listo", () => {
  const { onChange, line } = renderTicket("ready")
  fireEvent.click(screen.getByRole("button", { name: "Volver a preparar" }))
  expect(onChange).toHaveBeenCalledWith(line, "preparing")
})
it("desactiva todas las acciones mientras el servidor no confirma", () => {
  const { onChange } = renderTicket("fired", true)
  fireEvent.click(screen.getByRole("button", { name: "Empezar" }))
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getAllByRole("button").filter(b => b.textContent !== "Imprimir ticket").every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
})

it("selecciona solo los platos marchados de la estación y manda un lote", () => {
  const lines = [
    { id: "a", ...linea({ status: "fired" }) },
    { id: "b", ...linea({ status: "preparing" }) },
    { id: "retenida", ...linea({ status: "held" }) },
  ]
  const ticket = stationTickets(lines, "cocina", T0, 3)[0]!
  const onBatch = vi.fn()
  render(<Ticket ticket={ticket} now={T0} pickupMinutes={3} timezone="Europe/Madrid" disabled={false} onChange={vi.fn()} onBatch={onBatch} />)
  fireEvent.click(screen.getByRole("button", { name: "Seleccionar pendientes" }))
  fireEvent.click(screen.getByRole("button", { name: "Empezar 1" }))
  expect(onBatch).toHaveBeenLastCalledWith(["a"], "preparing")
  fireEvent.click(screen.getByRole("button", { name: "Dejar listos 2" }))
  expect(onBatch).toHaveBeenLastCalledWith(["a", "b"], "ready")
  expect(screen.getAllByRole("checkbox")).toHaveLength(2)
})
it("muestra nota general, origen y hora prometida de la recogida", () => {
  const line = { id: "a", ...linea({ takeawayId: "take1", sessionId: null, status: "held", ticket: { reference: "AB2345", source: "takeaway_web", note: "Salsa aparte", pickupAt: T0, pickupReference: "QR2345", guestName: "Ana" } }) }
  const ticket = stationTickets([line], "cocina", T0, 3)[0]!
  render(<Ticket ticket={ticket} now={T0} pickupMinutes={3} timezone="Europe/Madrid" disabled={false} onChange={vi.fn()} />)
  expect(screen.getByText("Nota del pedido: Salsa aparte")).toBeTruthy()
  expect(screen.getByText(/QR2345 · Ana/)).toBeTruthy()
  expect(screen.getByText(/Web para llevar/)).toBeTruthy()
  expect(screen.getByText(/Todavía no se está cocinando/)).toBeTruthy()
})
