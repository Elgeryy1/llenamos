/**
 * Datos compartidos por las pruebas de sala y cocina. No se exporta desde el paquete.
 */
import type { OrderLine } from "./modelo"

/** Lunes 9 de noviembre de 2026, 21:00 en Madrid. */
export const T0 = Date.UTC(2026, 10, 9, 20, 0)

export function linea(cambios: Partial<OrderLine> = {}): OrderLine {
  return {
    orderId: "o1",
    sessionId: "s1",
    takeawayId: null,
    label: "S3",
    kind: "item",
    parentLineId: null,
    position: 0,
    itemId: "bravas",
    dailyMenuId: null,
    sectionId: null,
    version: 1,
    name: { es: "Patatas bravas", ca: "", en: "" },
    variant: null,
    modifiers: [],
    quantity: 1,
    unitPriceCents: 650,
    totalCents: 650,
    notes: "",
    guest: null,
    course: "first",
    stationId: "cocina",
    stationKind: "kitchen",
    targetMinutes: 10,
    status: "fired",
    fireAt: null,
    placedAt: T0,
    firedAt: T0,
    startedAt: null,
    readyAt: null,
    servedAt: null,
    cancelReason: null,
    history: [],
    createdBy: "camarero",
    ...cambios,
  }
}
