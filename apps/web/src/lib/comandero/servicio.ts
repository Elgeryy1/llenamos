import type { FloorTaskWithId, OrderLineWithId, TableSessionWithId, OrderLineInput } from "@llenamos/core"

/** Prioridad operativa fija; el detalle conserva todos los estados simultáneos. */
export function estadoServicio(session: TableSessionWithId | undefined, tableId: string, tasks: readonly FloorTaskWithId[], lines: readonly OrderLineWithId[], now: number) {
  const active = tasks.filter(t => t.status === "open" || t.status === "claimed")
  const own = lines.filter(l => session && l.sessionId === session.id && l.kind !== "menu")
  const labels = [
    active.some(t => t.type === "call_waiter" && t.tableIds.includes(tableId)) ? "Llamada" : null,
    own.some(l => l.status === "ready") ? "Listo para servir" : null,
    own.some(l => l.status === "pending") ? "Pendiente de aprobación" : null,
    session?.status === "bill_requested" ? "Cuenta pedida" : null,
    own.some(l => l.status === "preparing" || l.status === "fired") ? "Preparando" : null,
  ].filter((v): v is string => !!v)
  return { labels, primary: labels[0], minutes: session ? Math.max(0, Math.floor((now - session.openedAt) / 60000)) : null }
}

/** Reconstruye la ronda usando elecciones, nunca sus precios congelados. */
export function repetirRonda(lines: readonly OrderLineWithId[]): OrderLineInput[] {
  const latest = [...lines].filter(l => l.kind !== "menu_component" && !["cancelled", "pending"].includes(l.status)).sort((a, b) => b.placedAt - a.placedAt)[0]
  if (!latest) return []
  return lines.filter(l => l.orderId === latest.orderId && l.kind !== "menu_component" && l.status !== "cancelled").sort((a, b) => a.position - b.position).map(l => l.kind === "item" ? {
    kind: "item", itemId: l.itemId!, quantity: l.quantity, variantId: l.variant?.id ?? null,
    optionIds: l.modifiers.map(m => m.optionId), notes: l.notes, guest: l.guest, ...(l.course ? { course: l.course } : {}),
  } : {
    kind: "menu", dailyMenuId: l.dailyMenuId!, quantity: l.quantity, notes: l.notes, guest: l.guest,
    selections: lines.filter(c => c.parentLineId === l.id && c.status !== "cancelled").map(c => ({ sectionId: c.sectionId!, itemId: c.itemId!, variantId: c.variant?.id ?? null, optionIds: c.modifiers.map(m => m.optionId), notes: c.notes })),
  })
}
