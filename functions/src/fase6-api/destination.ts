import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { HttpsError } from 'firebase-functions/v2/https'

/** Solo se admiten direcciones globales. IPv6 se limita a unicast global sin túneles. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
      (a === 192 && b === 88) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0))
  }
  if (isIP(address) === 6) {
    const v = address.toLowerCase()
    return /^[23][a-f0-9]{3}:/.test(v) && !/^(2001:(0*:|db8:|10:|20:)|2002:)/.test(v)
  }
  return false
}
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>
export async function assertIntegrationDestination(raw: string, resolve: Resolver = host => lookup(host, { all: true, verbatim: true })) {
  const fail = () => { throw new HttpsError('invalid-argument', 'El webhook necesita un destino HTTPS público, sin credenciales ni redirecciones.') }
  let url: URL
  try { url = new URL(raw) } catch { return fail() }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash) return fail()
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: { address: string; family: number }[]
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host) } catch { return fail() }
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) return fail()
  return { url, address: addresses[0]! }
}
export type WebhookTransport = (url: string, body: string, signature: string) => Promise<number>
/** DNS verificado por conexión y dirección fijada al socket; nunca sigue Location. */
export const sendWebhook: WebhookTransport = async (raw, body, signature) => {
  const destination = await assertIntegrationDestination(raw)
  // En emuladores no sale tráfico real. Las pruebas inyectan un receptor explícito.
  if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error('outbound_disabled')
  return new Promise<number>((resolve, reject) => {
    const req = httpsRequest(destination.url, { method: 'POST', agent: false, family: destination.address.family,
      lookup: (_host, _options, cb) => cb(null, destination.address.address, destination.address.family),
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Llenamos-Signature': signature },
    }, res => { const status = res.statusCode ?? 500; res.destroy(); resolve(status) })
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), 10_000)
    req.on('close', () => clearTimeout(deadline)); req.on('error', reject); req.end(body)
  })
}
