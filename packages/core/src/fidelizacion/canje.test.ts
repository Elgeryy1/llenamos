import { describe, expect, it } from "vitest"
import { discountAdjustments, planRewardDiscount, type RewardLine } from "./canje"

const line = (lineId: string, itemId: string | null, balanceCents: number, quantity = 1): RewardLine => ({ lineId, itemId, categoryId: null, balanceCents, quantity })

describe("descuento de un premio", () => {
  it("un descuento en euros no pasa del saldo de la cuenta", () => {
    const plan = planRewardDiscount({ kind: "amount", valueCents: 500, itemId: null }, [line("a", "x", 200), line("b", "y", 100)])
    expect(plan.amountCents).toBe(300)
    expect(plan.lines).toHaveLength(2)
  })
  it("un plato invitado descuenta una unidad con el tope del premio", () => {
    const plan = planRewardDiscount({ kind: "item", valueCents: 1000, itemId: "cafe" }, [line("a", "cafe", 440, 2), line("b", "otro", 900)])
    expect(plan).toMatchObject({ amountCents: 220, lines: [{ lineId: "a" }] })
    expect(planRewardDiscount({ kind: "item", valueCents: 150, itemId: "cafe" }, [line("a", "cafe", 440, 2)]).amountCents).toBe(150)
  })
  it("salta las líneas ya invitadas y devuelve cero si el plato no está", () => {
    expect(planRewardDiscount({ kind: "item", valueCents: 500, itemId: "cafe" }, [line("a", "cafe", 0), line("b", "cafe", 250)]).lines[0]?.lineId).toBe("b")
    expect(planRewardDiscount({ kind: "item", valueCents: 500, itemId: "cafe" }, [line("a", "otro", 250)]).amountCents).toBe(0)
  })
  it("los ajustes suman exactamente el descuento y llevan el origen", () => {
    const adjustments = discountAdjustments({ lines: [{ lineId: "a", balanceCents: 333 }, { lineId: "b", balanceCents: 667 }], amountCents: 101, kind: "reward", sourceId: "canje1", reason: "Premio", at: 5, by: "u" })
    expect(adjustments.reduce((s, a) => s + a.amountCents, 0)).toBe(101)
    expect(adjustments.every((a) => a.redemptionId === "canje1" && a.kind === "discount")).toBe(true)
    expect(discountAdjustments({ lines: [{ lineId: "a", balanceCents: 100 }], amountCents: 10, kind: "promotion", sourceId: "p", reason: "x", at: 1, by: "u" })[0]).toMatchObject({ id: "promo.p.a", promotionId: "p" })
  })
})
