/**
 * Compras: pedidos a proveedor, recepción parcial, precios y sugerencias.
 *
 * Un pedido es un borrador hasta que el encargado lo marca como enviado (Llenamos no envía el
 * pedido al proveedor: se pide por teléfono, WhatsApp o correo y aquí se registra). Cada línea
 * congela el formato y el precio con que se pidió. Se puede recibir en varias veces; cada
 * recepción es un albarán inmutable que entra en el almacén al precio **del albarán**, que puede
 * diferir del pedido. Recibir de más se admite y se marca. Precios sin IVA.
 */
import { roundRatio } from "../caja/cuenta"
import { ceilDiv } from "./coste"
import type { GoodsReceiptLine, PurchaseLine, PurchaseOrder, PurchaseStatus, SupplierItemWithId } from "./modelo"

export const PURCHASE_TRANSITIONS: Record<PurchaseStatus, readonly PurchaseStatus[]> = {
  draft: ["sent", "cancelled"],
  sent: ["partially_received", "received", "cancelled"],
  partially_received: ["received", "closed"],
  received: [],
  cancelled: [],
  closed: [],
}

export type PurchaseCheck = { ok: true } | { ok: false; message: string }

/** Comprueba un cambio de estado hecho a mano (enviar, anular, cerrar sin completar). */
export function checkPurchaseTransition(order: Pick<PurchaseOrder, "status" | "lines">, to: PurchaseStatus, reason: string | null): PurchaseCheck {
  if (!PURCHASE_TRANSITIONS[order.status].includes(to)) return { ok: false, message: "Ese cambio de estado no es posible." }
  if (to === "cancelled" && order.lines.some((l) => l.receivedFormats > 0)) return { ok: false, message: "Un pedido con recepciones no se anula: ciérralo sin completar." }
  if ((to === "cancelled" || to === "closed") && !(reason ?? "").trim()) return { ok: false, message: "Escribe el motivo." }
  return { ok: true }
}

export function purchaseTotal(lines: readonly Pick<PurchaseLine, "orderedFormats" | "priceCents">[]): number {
  return Number(lines.reduce((s, l) => s + BigInt(l.orderedFormats) * BigInt(l.priceCents), BigInt(0)))
}

/** Formatos que faltan por recibir en cada línea (nunca negativo). */
export function pendingFormats(lines: readonly Pick<PurchaseLine, "lineId" | "orderedFormats" | "receivedFormats">[]): { lineId: string; formats: number }[] {
  return lines.filter((l) => l.receivedFormats < l.orderedFormats).map((l) => ({ lineId: l.lineId, formats: l.orderedFormats - l.receivedFormats }))
}

export interface ReceiptInputLine { supplierItemId: string; receivedFormats: number; priceCents: number }

export interface ReceiptPlan {
  lines: GoodsReceiptLine[]
  totalCents: number
  /** Entradas de almacén: una por línea, con su valor al precio del albarán. */
  movements: { ingredientId: string; quantity: number; valueCents: number }[]
  /** Líneas del pedido con lo recibido actualizado, o null si es una recepción sin pedido. */
  orderLines: PurchaseLine[] | null
  status: PurchaseStatus | null
  pending: { lineId: string; formats: number }[]
  /** Líneas en las que se ha recibido más de lo pedido. */
  exceeded: { lineId: string; extraFormats: number }[]
  /** Precios del albarán distintos del último pagado (o del de lista si nunca se recibió). */
  priceChanges: { supplierItemId: string; previousCents: number; newCents: number; changeBp: number }[]
}

/**
 * Plan de una recepción. Con pedido: debe estar enviado o recibido en parte, cada línea del
 * albarán debe ser un formato del pedido y no se repite. Sin pedido (compra directa): cualquier
 * formato activo de ese proveedor. Lanza un error con mensaje en castellano si algo no cuadra.
 */
export function planReceipt(
  order: Pick<PurchaseOrder, "supplierId" | "status" | "lines"> | null,
  supplierId: string, items: ReadonlyMap<string, SupplierItemWithId>, input: readonly ReceiptInputLine[],
): ReceiptPlan {
  if (input.length === 0) throw new Error("El albarán no tiene líneas.")
  if (order && order.supplierId !== supplierId) throw new Error("El albarán es de otro proveedor.")
  if (order && order.status !== "sent" && order.status !== "partially_received") throw new Error("Ese pedido no admite recepciones.")
  if (new Set(input.map((l) => l.supplierItemId)).size !== input.length) throw new Error("Hay formatos repetidos en el albarán.")
  const orderLines = order ? order.lines.map((l) => ({ ...l })) : null
  const lines: GoodsReceiptLine[] = []
  const priceChanges: ReceiptPlan["priceChanges"] = []
  const exceeded: ReceiptPlan["exceeded"] = []
  for (const l of input) {
    if (!Number.isSafeInteger(l.receivedFormats) || l.receivedFormats < 1) throw new Error("Los formatos recibidos son un entero mayor que cero.")
    if (!Number.isSafeInteger(l.priceCents) || l.priceCents < 0) throw new Error("El precio va en céntimos enteros.")
    const item = items.get(l.supplierItemId)
    if (!item || item.supplierId !== supplierId) throw new Error("Ese formato no es de este proveedor.")
    if (!order && !item.active) throw new Error("Ese formato está desactivado.")
    let purchaseLineId: string | null = null
    let baseQuantity = item.baseQuantity
    if (orderLines) {
      const linea = orderLines.find((p) => p.supplierItemId === l.supplierItemId)
      if (!linea) throw new Error("Ese formato no está en el pedido.")
      purchaseLineId = linea.lineId
      baseQuantity = linea.baseQuantity
      linea.receivedFormats += l.receivedFormats
      if (linea.receivedFormats > linea.orderedFormats) exceeded.push({ lineId: linea.lineId, extraFormats: linea.receivedFormats - linea.orderedFormats })
    }
    const totalCents = Number(BigInt(l.receivedFormats) * BigInt(l.priceCents))
    lines.push({ supplierItemId: l.supplierItemId, ingredientId: item.ingredientId, purchaseLineId, receivedFormats: l.receivedFormats, baseQuantity, priceCents: l.priceCents, totalCents, receivedBase: l.receivedFormats * baseQuantity })
    const previo = item.lastPriceCents ?? item.priceCents
    if (previo !== l.priceCents) {
      priceChanges.push({ supplierItemId: l.supplierItemId, previousCents: previo, newCents: l.priceCents, changeBp: previo > 0 ? roundRatio(BigInt(l.priceCents - previo) * BigInt(10000), BigInt(previo)) : 10000 })
    }
  }
  const pending = orderLines ? pendingFormats(orderLines) : []
  return {
    lines, totalCents: lines.reduce((s, l) => s + l.totalCents, 0),
    movements: lines.map((l) => ({ ingredientId: l.ingredientId, quantity: l.receivedBase, valueCents: l.totalCents })),
    orderLines, status: orderLines ? (pending.length === 0 ? "received" : "partially_received") : null,
    pending, exceeded, priceChanges,
  }
}

export interface ReorderIngredient { id: string; quantity: number; minQuantity: number; targetQuantity: number | null; active: boolean }
export interface SuggestedOrder {
  supplierId: string
  lines: { supplierItemId: string; ingredientId: string; formats: number; totalCents: number }[]
  totalCents: number
  /** El total no llega al pedido mínimo del proveedor. */
  belowMinimum: boolean
}

/** Cantidad base que ya viene de pedidos abiertos (pedida y no recibida), por ingrediente. */
export function onOrderByIngredient(orders: readonly Pick<PurchaseOrder, "status" | "lines">[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const o of orders) {
    if (o.status !== "sent" && o.status !== "partially_received") continue
    for (const l of o.lines) {
      const falta = Math.max(0, l.orderedFormats - l.receivedFormats) * l.baseQuantity
      out.set(l.ingredientId, (out.get(l.ingredientId) ?? 0) + falta)
    }
  }
  return out
}

/** Elige el formato: el preferido activo; si no, el más barato por unidad base (empate: id). */
export function chooseSupplierItem(items: readonly SupplierItemWithId[]): SupplierItemWithId | null {
  const activos = items.filter((i) => i.active)
  const preferido = activos.filter((i) => i.preferred).sort((a, b) => (a.id < b.id ? -1 : 1))[0]
  if (preferido) return preferido
  return [...activos].sort((a, b) => {
    const x = BigInt(a.priceCents) * BigInt(b.baseQuantity)
    const y = BigInt(b.priceCents) * BigInt(a.baseQuantity)
    return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : 1
  })[0] ?? null
}

/**
 * Pedidos sugeridos. Se pide cuando `existencias + ya pedido` está en el mínimo o por debajo (y
 * hay mínimo), hasta el objetivo del ingrediente (el doble del mínimo si no tiene), en formatos
 * enteros redondeando hacia arriba. Agrupa por proveedor. Los ingredientes sin formato activo
 * se devuelven aparte para que el encargado los atienda.
 */
export function suggestOrders(
  ingredients: readonly ReorderIngredient[], items: readonly SupplierItemWithId[],
  suppliers: ReadonlyMap<string, { minOrderCents: number; active: boolean }>, onOrder: ReadonlyMap<string, number>,
): { orders: SuggestedOrder[]; withoutSupplier: string[] } {
  const porProveedor = new Map<string, SuggestedOrder>()
  const withoutSupplier: string[] = []
  for (const ing of [...ingredients].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!ing.active || ing.minQuantity <= 0) continue
    const disponible = ing.quantity + (onOrder.get(ing.id) ?? 0)
    if (disponible > ing.minQuantity) continue
    const item = chooseSupplierItem(items.filter((i) => i.ingredientId === ing.id && suppliers.get(i.supplierId)?.active === true))
    if (!item) { withoutSupplier.push(ing.id); continue }
    const objetivo = ing.targetQuantity ?? ing.minQuantity * 2
    const falta = objetivo - disponible
    const formats = Math.max(1, ceilDiv(falta, item.baseQuantity))
    const totalCents = Number(BigInt(formats) * BigInt(item.priceCents))
    const pedido = porProveedor.get(item.supplierId) ?? { supplierId: item.supplierId, lines: [], totalCents: 0, belowMinimum: false }
    pedido.lines.push({ supplierItemId: item.id, ingredientId: ing.id, formats, totalCents })
    pedido.totalCents += totalCents
    porProveedor.set(item.supplierId, pedido)
  }
  const orders = [...porProveedor.values()].sort((a, b) => (a.supplierId < b.supplierId ? -1 : 1))
  for (const o of orders) o.belowMinimum = o.totalCents < (suppliers.get(o.supplierId)?.minOrderCents ?? 0)
  return { orders, withoutSupplier }
}
