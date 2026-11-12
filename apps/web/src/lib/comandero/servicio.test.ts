import { describe, expect, it } from "vitest"
import { FloorTaskSchema, type TableSessionWithId } from "@llenamos/core"
import { linea, T0 } from "../../../../../packages/core/src/sala/datos-prueba"
import { estadoServicio, repetirRonda } from "./servicio"

const session: TableSessionWithId = {
  id: "s1", tableIds: ["t1"], label: "S1", guests: 2, status: "bill_requested", reservationId: null, customerId: null, guestName: null,
  waiterUid: null, waiterName: null, notes: "", openedAt: T0 - 30 * 60000, openedBy: "diego", closedAt: null, closedBy: null, billRequestedAt: T0,
  mergedInto: null, totalCents: 0, lineCount: 0, unservedCount: 0, history: [],
}
const task = { id: "t", ...FloorTaskSchema.parse({
  type: "call_waiter", status: "claimed", sessionId: "s1", takeawayId: null, tableIds: ["t1"], label: "S1", orderId: null, stationId: null, lineIds: [], note: "Agua", dedupeKey: null,
  count: 1, openedAt: T0, dueAt: T0, createdBy: null, claimedBy: "diego", claimedByName: "Diego", claimedAt: T0, doneAt: null, doneBy: null,
}) }
describe("lectura y repetición de servicio", () => {
  it("ordena estados simultáneos y conserva el tiempo sentado y todos los avisos", () => {
    const lines = ["pending", "preparing", "ready"].map((status, i) => ({ id: `l${i}`, ...linea({ status: status as "pending" | "preparing" | "ready" }) }))
    const full = estadoServicio(session, "t1", [task], lines, T0)
    expect(full.labels).toEqual(["Llamada", "Listo para servir", "Pendiente de aprobación", "Cuenta pedida", "Preparando"])
    expect(full.primary).toBe("Llamada")
    expect(full.minutes).toBe(30)
    expect(estadoServicio(session, "t1", [{ ...task, status: "done" }], lines, T0).primary).toBe("Listo para servir")
    expect(estadoServicio(session, "t1", [], lines.filter(l => l.status !== "ready"), T0).primary).toBe("Pendiente de aprobación")
    expect(estadoServicio(session, "t1", [], [], T0).primary).toBe("Cuenta pedida")
  })
  it("repite elecciones con variantes, extras y notas y excluye rondas anuladas o pendientes", () => {
    const old = { id: "antigua", ...linea({ placedAt: T0 - 1000 }) }
    const recent = { id: "actual", ...linea({ orderId: "o2", variant: { id: "racion", name: { es: "Ración", ca: "", en: "" }, priceCents: 900 }, modifiers: [{ groupId: "extras", optionId: "queso", name: { es: "Queso", ca: "", en: "" }, priceCents: 150 }], notes: "Sin sal", guest: 2, quantity: 3 }) }
    const cancelled = { id: "anulada", ...linea({ orderId: "o3", placedAt: T0 + 1000, status: "cancelled" }) }
    expect(repetirRonda([old, recent, cancelled])).toEqual([{ kind: "item", itemId: "bravas", variantId: "racion", optionIds: ["queso"], notes: "Sin sal", guest: 2, quantity: 3, course: "first" }])
  })
})
