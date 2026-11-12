import {
  ORDER_PROBLEM_TEXT, OrderLineInputSchema, type OrderLineInput,
  sessionIsOpen,
  type OrderProblem,
  type TableSessionWithId,
} from "@llenamos/core"

export const euros = (cents: number) =>
  new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(
    cents / 100,
  )

/** El borrador queda unido a su destino original, incluso si otra persona mueve la mesa. */
export function firmaMesa(session: TableSessionWithId): string {
  return JSON.stringify([
    session.id,
    [...session.tableIds].sort(),
    session.openedAt,
    session.customerId,
    session.guests,
    session.status,
  ])
}

export function revisarDestino(
  original: string,
  current: TableSessionWithId | null,
): string | null {
  if (!current)
    return "La sesión ya no está disponible. El pedido sigue sin enviar."
  if (!sessionIsOpen(current.status))
    return "La mesa se ha cerrado o juntado con otra. El pedido sigue sin enviar. Abre el destino correcto y vuelve a tomarlo."
  if (firmaMesa(current) !== original)
    return "La mesa ha cambiado mientras pedías. Revisa sus mesas y comensales antes de enviar."
  return null
}

export function problemasPedido(problems: readonly OrderProblem[]): string {
  return problems
    .map(
      (p) =>
        `${p.line === null ? "Pedido" : `Línea ${p.line + 1}`}${p.selection === null ? "" : `, elección ${p.selection + 1}`}: ${ORDER_PROBLEM_TEXT.es[p.code]}`,
    )
    .join(" ")
}

/** Se normalizan las elecciones para sumar aunque los campos lleguen en otro orden. */
export function sumarRepetido(all: OrderLineInput[], line: OrderLineInput): OrderLineInput[] {
  const signature = (value: OrderLineInput) => {
    const parsed = OrderLineInputSchema.parse({ ...value, quantity: 1 })
    if (parsed.kind === "item") parsed.optionIds.sort()
    else parsed.selections.forEach(selection => selection.optionIds.sort())
    return JSON.stringify(parsed)
  }
  const key = signature(line)
  const index = all.findIndex(existing => signature(existing) === key && existing.quantity + line.quantity <= 99)
  return index < 0 ? [...all, line] : all.map((existing, i) => i === index ? { ...existing, quantity: existing.quantity + line.quantity } : existing)
}
