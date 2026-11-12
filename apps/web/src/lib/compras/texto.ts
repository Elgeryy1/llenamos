import type { BaseUnit, PurchaseOrder, Supplier } from "@llenamos/core"
import { cantidadFormato } from "./modelo"
import { euros } from "./dinero"

const DIA_LARGO = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })

/** «2026-11-11» pasa a «miércoles 11 de noviembre». */
export function fechaLarga(fecha: string): string {
  const [y, m, d] = fecha.split("-").map(Number)
  return DIA_LARGO.format(new Date(Date.UTC(y!, m! - 1, d))).replace(",", "")
}

export interface OpcionesTexto {
  restaurante: string
  local: string | null
  /** Con el precio de cada formato y el total sin IVA. */
  conPrecios: boolean
  /** Solo lo que falta por recibir (para reclamar al proveedor). */
  soloPendiente: boolean
  unidadDe: (ingredientId: string) => BaseUnit
}

/**
 * El texto del pedido para pegar en WhatsApp, un correo o leer por teléfono. Llenamos no lo envía:
 * lo copia el encargado. Sin guiones dentro de las frases y sin precios salvo que se pidan.
 */
export function textoPedido(order: Pick<PurchaseOrder, "reference" | "lines" | "expectedOn" | "notes">, supplier: Pick<Supplier, "contact" | "name">, o: OpcionesTexto): string {
  const lineas = order.lines
    .map((l) => ({ l, formats: o.soloPendiente ? Math.max(0, l.orderedFormats - l.receivedFormats) : l.orderedFormats }))
    .filter((x) => x.formats > 0)
  const nombre = supplier.contact?.trim().split(/\s+/)[0]
  const sitio = o.local ? `${o.restaurante} (${o.local})` : o.restaurante
  const out: string[] = []
  out.push(nombre ? `Hola ${nombre},` : "Hola,")
  out.push("")
  out.push(
    o.soloPendiente
      ? `Del pedido ${order.reference} de ${sitio} nos falta por recibir:`
      : `Pedido ${order.reference} de ${sitio}${order.expectedOn ? ` para el ${fechaLarga(order.expectedOn)}` : ""}:`,
  )
  out.push("")
  let total = 0
  for (const { l, formats } of lineas) {
    const tamano = cantidadFormato(l.baseQuantity, o.unidadDe(l.ingredientId))
    const precio = o.conPrecios ? ` a ${euros(l.priceCents)}` : ""
    // Si el nombre del formato ya dice el tamaño («Saco 25 kg») no se repite entre paréntesis.
    const sufijo = l.name.toLowerCase().includes(tamano.toLowerCase()) ? "" : ` (${tamano})`
    out.push(`• ${formats} x ${l.name}${sufijo}${precio}`)
    total += formats * l.priceCents
  }
  if (o.conPrecios) {
    out.push("")
    out.push(`Total sin IVA: ${euros(total)}`)
  }
  if (order.notes.trim()) {
    out.push("")
    out.push(`Nota: ${order.notes.trim()}`)
  }
  out.push("")
  out.push("Gracias.")
  return out.join("\n")
}
