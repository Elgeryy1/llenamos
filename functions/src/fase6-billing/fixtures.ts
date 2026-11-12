/** Cargas ficticias de Billing. No contienen claves ni identificadores de Stripe reales. */
export function invoiceFixture(input: { customer: string; subscription: string; price: string; amount: number; end: number; paid?: boolean; invoiceId?: string }) {
  const paid = input.paid ?? true
  return { id: input.invoiceId ?? 'in_fixture', object: 'invoice', customer: input.customer, parent: { type: 'subscription_details', subscription_details: { subscription: input.subscription } }, currency: 'eur', status: paid ? 'paid' : 'open', paid, amount_paid: paid ? input.amount : 0, amount_due: input.amount, total: input.amount, lines: { has_more: false as const, data: [{ quantity: 1 as const, amount: input.amount, currency: 'eur' as const, pricing: { type: 'price_details', price_details: { price: input.price } }, period: { start: Math.floor(input.end/1000)-30*86400, end: Math.floor(input.end/1000) } }] } }
}
export function eventFixture(id: string, type: string, object: unknown, created = Math.floor(Date.now()/1000)) {
  return { id, object: 'event', api_version: '2025-06-30.basil', livemode: false, type, created, data: { object } }
}
export function subscriptionFixture(customer: string, subscription: string, price: string, status = 'active', latest_invoice?: unknown) {
  return { id: subscription, object: 'subscription', customer, status, cancel_at_period_end: false, items: { data: [{ id: 'si_fixture', price: { id: price }, quantity: 1 }] }, ...(latest_invoice ? { latest_invoice } : {}) }
}
