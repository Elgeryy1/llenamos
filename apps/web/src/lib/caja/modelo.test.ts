import { describe, expect, it } from "vitest"
import { centimos, reparto } from "./modelo"
import type { Bill } from "@llenamos/core"

export const cuentaPrueba: Bill = {
  target: { kind: "session", id: "s" },
  customerId: null,
  status: "open",
  revision: 3,
  totalCents: 1001,
  paidCents: 0,
  refundedCents: 0,
  openedAt: 1,
  lockedAt: null,
  settledAt: null,
  adjustments: [],
  lines: [
    {
      lineId: "menu",
      parentLineId: null,
      name: "Menú",
      quantity: 1,
      grossCents: 900,
      taxRate: 10,
      guest: 1,
    },
    {
      lineId: "extra",
      parentLineId: "menu",
      name: "Suplemento",
      quantity: 1,
      grossCents: 100,
      taxRate: 10,
      guest: 1,
    },
    {
      lineId: "pan",
      parentLineId: null,
      name: "Pan",
      quantity: 1,
      grossCents: 1,
      taxRate: 10,
      guest: 2,
    },
  ],
}
describe("importes de caja y reparto visible", () => {
  it("convierte sin redondear ni aceptar exponentes, negativos o un tercer decimal", () => {
    expect(centimos("12,30")).toBe(1230)
    expect(centimos("0.01")).toBe(1)
    expect(centimos("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER)
    for (const value of [
      "1,001",
      "1e3",
      "-1",
      "",
      "1.234,56",
      "90071992547409.92",
    ])
      expect(() => centimos(value)).toThrow()
  })
  it("conserva el céntimo sobrante y aplica los ajustes antes del reparto", () => {
    expect(
      reparto(cuentaPrueba, "equal", "3", "", {}).preview.map(
        (p) => p.totalCents,
      ),
    ).toEqual([334, 334, 333])
    const bill = {
      ...cuentaPrueba,
      adjustments: [
        {
          id: "a",
          lineId: "menu",
          kind: "invitation" as const,
          amountCents: 101,
          reason: "Invitación",
          at: 1,
          by: "u",
        },
      ],
    }
    expect(
      reparto(bill, "equal", "2", "", {}).preview.map((p) => p.totalCents),
    ).toEqual([450, 450])
  })
  it("mueve el menú con todos sus suplementos y exige repartir cada plato", () => {
    const plan = reparto(cuentaPrueba, "dishes", "2", "", {
      menu: "1",
      pan: "2",
    })
    expect(plan.preview.map((p) => p.totalCents)).toEqual([1000, 1])
    expect(plan.preview[0]?.allocations.map((a) => a.lineId)).toEqual([
      "menu",
      "extra",
    ])
    expect(() => reparto(cuentaPrueba, "dishes", "2", "", {})).toThrow()
  })
  it("los importes tienen que sumar exactamente el total", () => {
    expect(
      reparto(cuentaPrueba, "amount", "2", "5,00; 5,01", {}).preview.map(
        (p) => p.totalCents,
      ),
    ).toEqual([500, 501])
    expect(() => reparto(cuentaPrueba, "amount", "2", "5; 5", {})).toThrow()
  })
})
