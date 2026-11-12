import {
  formatQuantity,
  type BaseUnit,
  type PurchaseOrder,
  type PurchaseStatus,
  type SupplierItem,
} from "@llenamos/core"
import { euros } from "./dinero"

/** «Saco 25 kg» trae 25 kg: cantidad de un formato en la unidad que mejor se lee. */
export function cantidadFormato(baseQuantity: number, unit: BaseUnit): string {
  return formatQuantity(baseQuantity, unit)
}

/** Precio por kilo, litro o unidad (solo para comparar al verlo; redondeado al céntimo). */
export function precioPorUnidad(priceCents: number, baseQuantity: number, unit: BaseUnit): string {
  const factor = unit === "u" ? 1 : 1000
  const num = BigInt(priceCents) * BigInt(factor)
  const den = BigInt(baseQuantity)
  const cents = Number((num + den / BigInt(2)) / den)
  return `${euros(cents)} por ${unit === "g" ? "kg" : unit === "ml" ? "l" : "ud"}`
}

export type GrupoPedido = "por_recibir" | "borrador" | "cerrado"
export const GRUPO_PEDIDO: Record<PurchaseStatus, GrupoPedido> = {
  draft: "borrador",
  sent: "por_recibir",
  partially_received: "por_recibir",
  received: "cerrado",
  cancelled: "cerrado",
  closed: "cerrado",
}

/** Formatos y dinero que faltan por recibir (precio de pedido, sin IVA). */
export function pendienteDePedido(order: Pick<PurchaseOrder, "lines">): { formats: number; cents: number } {
  let formats = 0
  let cents = 0
  for (const l of order.lines) {
    const falta = Math.max(0, l.orderedFormats - l.receivedFormats)
    formats += falta
    cents += falta * l.priceCents
  }
  return { formats, cents }
}

/** Cifras del resumen. Solo cuenta lo que se espera: enviados o recibidos en parte. */
export function resumenPedidos(orders: readonly Pick<PurchaseOrder, "status" | "lines">[]) {
  let borradores = 0
  let porRecibir = 0
  let enParte = 0
  let pendienteCents = 0
  for (const o of orders) {
    if (o.status === "draft") borradores += 1
    if (o.status === "sent" || o.status === "partially_received") {
      porRecibir += 1
      pendienteCents += pendienteDePedido(o).cents
    }
    if (o.status === "partially_received") enParte += 1
  }
  return { borradores, porRecibir, enParte, pendienteCents }
}

/** Variación del último precio pagado frente al de lista, en puntos básicos (null si nunca se ha recibido o es igual). */
export function derivaDePrecio(item: Pick<SupplierItem, "priceCents" | "lastPriceCents">): number | null {
  if (item.lastPriceCents === null || item.lastPriceCents === item.priceCents) return null
  if (item.priceCents <= 0) return 10_000
  const num = BigInt(item.lastPriceCents - item.priceCents) * BigInt(10_000)
  const den = BigInt(item.priceCents)
  const half = den / BigInt(2)
  return Number(num >= BigInt(0) ? (num + half) / den : -((-num + half) / den))
}
