import type { Message, RenderedMessage } from "../message-model"

const texts = {
 es: { takeaway_accepted: "Pedido aceptado para recoger", takeaway_ready: "Tu pedido está listo para recoger", confirmation: "Reserva confirmada", pending: "Reserva pendiente de confirmación", reminder: "Te recordamos tu reserva", cancellation: "Reserva cancelada", waitlist_offer: "Hay sitio para ti", deposit_request: "Completa la señal de tu reserva", review_request: "¿Cómo fue tu visita? Déjanos una reseña", marketing_campaign: "Novedades", daily_summary: "Resumen del día", unsubscribe: "Si no quieres recibir más mensajes, date de baja aquí", confirm: "Confirmo", cancel: "Cancelar", guests: "personas", reference: "Referencia" },
 ca: { takeaway_accepted: "Comanda acceptada per recollir", takeaway_ready: "La teva comanda és a punt per recollir", confirmation: "Reserva confirmada", pending: "Reserva pendent de confirmació", reminder: "Et recordem la teva reserva", cancellation: "Reserva cancel·lada", waitlist_offer: "Hi ha lloc per a tu", deposit_request: "Completa la paga i senyal de la reserva", review_request: "Com ha anat la visita? Deixa’ns una ressenya", marketing_campaign: "Novetats", daily_summary: "Resum del dia", unsubscribe: "Si no vols rebre més missatges, dona’t de baixa aquí", confirm: "Confirmo", cancel: "Cancel·lar", guests: "persones", reference: "Referència" },
 en: { takeaway_accepted: "Takeaway order accepted", takeaway_ready: "Your order is ready for pickup", confirmation: "Booking confirmed", pending: "Booking awaiting confirmation", reminder: "A reminder of your booking", cancellation: "Booking cancelled", waitlist_offer: "A table is available for you", deposit_request: "Pay your booking deposit", review_request: "How was your visit? Leave us a review", marketing_campaign: "News", daily_summary: "Daily summary", unsubscribe: "To stop receiving these messages, unsubscribe here", confirm: "Confirm", cancel: "Cancel", guests: "guests", reference: "Reference" },
} as const
export type MessageButton = { id: "confirm" | "cancel"; title: string }
/** Campañas: title, body, ctaUrl, unsubscribeUrl. Resumen diario: summaryText.
 * Datos compartidos: guestName, restaurantName, partySize, startAt, timezone,
 * reference, manageUrl, offerUrl, paymentUrl, googleReviewUrl. Acepta date/time de R1. */
export function renderMessage(message: Pick<Message, "template" | "language" | "channel" | "data">): RenderedMessage & { buttons: MessageButton[] } {
 const t = texts[message.language]
 const d = message.data
 const value = (key: string) => d[key] == null ? "" : String(d[key])
 const when = typeof d.startAt === "number" ? new Intl.DateTimeFormat(message.language, { timeZone: value("timezone") || "Europe/Madrid", dateStyle: "medium", timeStyle: "short" }).format(d.startAt) : [value("date"), value("time")].filter(Boolean).join(" ")
 if (message.template === "marketing_campaign") {
  // Campaña (fase 5): título y texto del encargado, enlace opcional y baja siempre presente.
  const heading = value("title") || t.marketing_campaign
  const body = [heading, value("restaurantName"), value("guestName"), value("body"), value("ctaUrl"), value("unsubscribeUrl") ? `${t.unsubscribe}: ${value("unsubscribeUrl")}` : ""].filter(Boolean).join("\n")
  return { subject: message.channel === "email" ? heading : null, body, buttons: [] }
 }
 if (message.template === "daily_summary") {
  // Resumen diario (fase 5): texto ya preparado en el servidor con `renderDailySummary`.
  const heading = `${t.daily_summary} · ${value("restaurantName")}`.replace(/ · $/, "")
  const body = [heading, value("guestName"), value("summaryText")].filter(Boolean).join("\n")
  return { subject: message.channel === "email" ? heading : null, body, buttons: [] }
 }
 const heading = message.template === "digital_receipt" ? ({ es: "Tu recibo digital", ca: "El teu rebut digital", en: "Your digital receipt" } as const)[message.language] : t[message.template]
 const url = message.template === "review_request" ? value("googleReviewUrl") : message.template === "waitlist_offer" ? value("offerUrl") : message.template === "deposit_request" ? value("paymentUrl") || value("manageUrl") : value("manageUrl")
 const body = [heading, value("restaurantName"), value("guestName"), when, typeof d.totalCents === "number" ? new Intl.NumberFormat(message.language, { style: "currency", currency: "EUR" }).format(d.totalCents / 100) : "", value("locationName"), value("address"), value("phone"), d.partySize ? `${d.partySize} ${t.guests}` : "", d.reference ? `${t.reference}: ${d.reference}` : "", url].filter(Boolean).join("\n")
 const buttons: MessageButton[] = message.channel === "whatsapp" && ["confirmation", "pending", "reminder"].includes(message.template) ? [{ id: "confirm", title: t.confirm }, { id: "cancel", title: t.cancel }] : []
 return { subject: message.channel === "email" ? heading : null, body, buttons }
}
