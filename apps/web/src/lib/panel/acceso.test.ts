import { describe, expect, it } from "vitest"
import { accesoVencido } from "./acceso"

describe("accesoVencido", () => {
  it("solo vence en restaurantes con suscripción y pasada la fecha", () => {
    expect(accesoVencido({ entitlementVersion: 1, accessValidUntil: 1000 }, 999)).toBe(false)
    expect(accesoVencido({ entitlementVersion: 1, accessValidUntil: 1000 }, 1000)).toBe(true)
    expect(accesoVencido({ accessValidUntil: 1000 }, 5000)).toBe(false)
    expect(accesoVencido({ entitlementVersion: 1 }, 5000)).toBe(false)
  })
})
