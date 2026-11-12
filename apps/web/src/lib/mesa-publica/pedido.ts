import {
  priceOrder,
  publicMenuCatalog,
  PublicOrderLinesInputSchema,
  type OrderLineInput,
  type PublicMenu,
} from "@llenamos/core"
export function reviewOrder(
  menu: PublicMenu,
  lines: readonly OrderLineInput[],
  channel: "table" | "takeaway",
  now: number,
  expectedTotalCents?: number,
) {
  const parsed = PublicOrderLinesInputSchema.parse(lines)
  return priceOrder(parsed, publicMenuCatalog(menu), { channel, now, timezone: menu.timezone, expectedTotalCents })
}
export function changedSession(previous: string | null, current: string | null) {
  return previous !== current
}
export const callMesa = async <N extends "verMesaPublica" | "pedirDesdeMesa" | "avisarDesdeMesa">(
  name: N,
  input: import("@llenamos/core").CallableInput<N>,
) => {
  const { callService } = await import("@/lib/carta/callables")
  return callService(name, input)
}
