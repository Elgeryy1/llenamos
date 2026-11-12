/** Cargas de ejemplo contra Functions local. No contienen una sesión bancaria existente. */
import { createHmac } from 'node:crypto'
async function main() {
  const secret = 'mobile_local_example', seconds = Math.floor(Date.now() / 1000)
  const raw = JSON.stringify({ id: 'evt_mobile_http_example', type: 'checkout.session.completed', created: seconds,
    data: { object: { id: 'cs_test_example_not_a_payment', status: 'complete', payment_status: 'paid', amount_total: 100,
      currency: 'eur', livemode: false, expires_at: seconds + 1800, metadata: {} } } })
  const sign = (t: number) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`
  for (const [name, signature, expected] of [['buena', sign(seconds), 200], ['repetida', sign(seconds), 200],
    ['mala', `t=${seconds},v1=${'0'.repeat(64)}`, 400], ['caducada', sign(seconds - 301), 400]] as const) {
    const response = await fetch('http://127.0.0.1:5016/demo-llenamos/europe-west1/stripeCuentaWebhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature }, body: raw,
    })
    if (response.status !== expected) throw new Error(`Firma ${name}: ${response.status}, se esperaba ${expected}.`)
    console.log(`Firma ${name}: ${response.status}.`)
  }
}
void main().catch(e => { console.error(e); process.exitCode = 1 })
