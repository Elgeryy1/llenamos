import {
  netBillLines,
  splitBill,
  sumCents,
  type Bill,
  type SplitSpec,
} from "@llenamos/core"

/** Conversión decimal exacta. No redondea importes escritos por la persona. */
export function centimos(text: string): number {
  const value = text.trim().replace(",", ".")
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new Error("Escribe un importe con un máximo de dos decimales.")
  const [whole, decimal = ""] = value.split(".")
  const amount = Number(
    BigInt(whole!) * BigInt(100) + BigInt(decimal.padEnd(2, "0")),
  )
  if (!Number.isSafeInteger(amount))
    throw new Error("El importe es demasiado grande.")
  return amount
}
export function decimal(cents: number) {
  return (cents / 100).toFixed(2).replace(".", ",")
}
export function euros(cents: number) {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100)
}
export function fecha(ms: number, timezone: string) {
  return new Intl.DateTimeFormat("es-ES", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: timezone,
  }).format(ms)
}
export const estadoCuenta = {
  open: "Por preparar",
  locked: "Lista para cobrar",
  settled: "Saldada",
  cancelled: "Anulada",
} as const
export const metodoPago = {
  cash: "Efectivo",
  card: "Datáfono externo",
  stripe: "Stripe",
  deposit: "Señal",
} as const
export const estadoPago = {
  pending: "Pendiente",
  succeeded: "Confirmado",
  failed: "Fallido",
  cancelled: "Cancelado",
} as const
export const estadoImpresion = {
  queued: "En cola",
  leased: "Enviando",
  printed: "Impreso",
  failed: "Fallido",
  uncertain: "Envío incierto, revisa la impresora",
  cancelled: "Cancelado",
  not_configured: "Sin impresora configurada",
} as const

export function reparto(
  bill: Bill,
  kind: SplitSpec["kind"],
  count: string,
  amounts: string,
  assignments: Record<string, string>,
) {
  const n = Number(count)
  if (!Number.isInteger(n) || n < 1 || n > 200)
    throw new Error("Elige entre 1 y 200 partes.")
  const split: SplitSpec =
    kind === "equal"
      ? { kind, parts: n }
      : kind === "amount"
        ? {
            kind,
            amountsCents: amounts.split(";").map(centimos),
          }
        : {
            kind,
            lineIds: Array.from({ length: n }, (_, i) =>
              bill.lines
                .filter(
                  (l) =>
                    l.parentLineId === null &&
                    (assignments[l.lineId] ?? "1") === String(i + 1),
                )
                .map((l) => l.lineId),
            ),
          }
  const preview = splitBill(netBillLines(bill.lines, bill.adjustments), split)
  return { split, preview }
}
export function importeLineas(bill: Bill) {
  return sumCents(
    netBillLines(bill.lines, bill.adjustments).map((l) => l.grossCents),
  )
}
