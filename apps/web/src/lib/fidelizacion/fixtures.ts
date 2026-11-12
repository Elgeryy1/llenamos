/** Datos inventados para la ruta de demostración. Nunca sustituyen una lectura real fallida. */
import { CALLABLE_SCHEMAS, type Bill, type CallableOutput, type LoyaltySettings, type LoyaltyReward, type Promotion, type RepiteSettings } from "@llenamos/core"
import type { ApiFidelizacion } from "./api"
import { nuevaPromocion } from "./presentacion"

export const FECHA_FIXTURE = Date.UTC(2026, 10, 10, 12)
export const CLIENTE_FIXTURE = "aaaaaaaaaaaaaaaaaaaa"
export const programaFixture: LoyaltySettings = { enabled: true, pointsPerEuro: 2, minSpendCents: 1000, expiryDays: 365, termsVersion: "2026.1" }
export const premiosFixture: (LoyaltyReward & { id: string })[] = [
  { id: "premio-cafe", name: "Un café para la próxima charla", pointsCost: 50, kind: "item", valueCents: 220, itemId: "cafe", active: true, revision: 1 },
  { id: "premio-cuenta", name: "Cinco euros para volver", pointsCost: 150, kind: "amount", valueCents: 500, itemId: null, active: true, revision: 2 },
]
export const promocionesFixture: (Promotion & { id: string })[] = [
  { ...nuevaPromocion(), id: "promo-cena", name: "Las noches del jueves", description: "Un motivo para alargar la sobremesa.", discount: { kind: "percent", bp: 1500 }, weekdays: [4], timeWindows: [{ from: "22:00", to: "02:00" }], usageLimit: 40, perCustomerLimit: 1, uses: 12, revision: 2, status: "active", stacking: "with_loyalty" },
  { ...nuevaPromocion(), id: "promo-vuelve", name: "Vuelve a Lumbre", discount: { kind: "amount", cents: 500 }, code: "VUELVE", minSpendCents: 3000, uses: 0, revision: 1, status: "paused" },
]
export const repiteFixture: RepiteSettings = { merchantId: null, enabled: false, stampOn: "both", autoCreateCard: false }
export const cuentaPuntosFixture: CallableOutput<"verCuentaFidelizacion"> = {
  enrolled: true, available: 180, expiringIn30Days: 35, earned: 280, redeemed: 100, expired: 0,
  movements: [
    { id: "earn.cena", kind: "earn", points: 80, balanceAfter: 180, at: FECHA_FIXTURE, reason: "Cena en Lumbre" },
    { id: "redeem.cafe", kind: "redeem", points: -100, balanceAfter: 100, at: FECHA_FIXTURE - 86400000, reason: "Premio de la visita anterior" },
    { id: "earn.comida", kind: "earn", points: 200, balanceAfter: 200, at: FECHA_FIXTURE - 604800000, reason: "Comida del domingo" },
  ],
  rewards: premiosFixture.map((r) => ({ rewardId: r.id, name: r.name, pointsCost: r.pointsCost, affordable: true })),
}
export const promocionesAplicablesFixture: CallableOutput<"promocionesAplicables"> = {
  channel: "dine_in", best: { promotionId: "promo-cena", name: "Las noches del jueves", discountCents: 630 },
  evaluations: [
    { promotionId: "promo-cena", name: "Las noches del jueves", eligible: true, discountCents: 630, reason: null },
    { promotionId: "promo-vuelve", name: "Vuelve a Lumbre", eligible: false, discountCents: null, reason: "code" },
  ],
}
export const cuentaFixture: Bill & { id: string } = {
  id: "cuenta-ejemplo", target: { kind: "session", id: "mesa-ejemplo" }, customerId: CLIENTE_FIXTURE, status: "open", revision: 1,
  lines: [{ lineId: "linea-cena", parentLineId: null, name: "Cena para dos", quantity: 1, grossCents: 4200, taxRate: 10, guest: null }], adjustments: [],
  totalCents: 4200, paidCents: 0, refundedCents: 0, openedAt: FECHA_FIXTURE, lockedAt: null, settledAt: null,
}
export const apiFixture: ApiFidelizacion = async (nombre, entrada) => {
  CALLABLE_SCHEMAS[nombre].input.parse(entrada)
  let datos: unknown
  if (nombre === "verCuentaFidelizacion") datos = cuentaPuntosFixture
  else if (nombre === "promocionesAplicables") datos = promocionesAplicablesFixture
  else if (nombre === "verTarjetaRepite" || nombre === "informeRepite") datos = { status: "not_configured", message: "Repite no está conectado. Esta vista usa datos de ejemplo." }
  else throw new Error("Esta es una demostración con datos de ejemplo. Falta el backend para confirmar esta operación. No se ha guardado nada.")
  return CALLABLE_SCHEMAS[nombre].output.parse(datos) as CallableOutput<typeof nombre>
}
