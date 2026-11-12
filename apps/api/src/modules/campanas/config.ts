import type { PoolClient } from 'pg'
import { ApiError } from '../../errors.js'

/** Tope duro de clientes del segmento por campaña. Por encima, previsualizar, simular y lanzar fallan con failed-precondition. */
export const MAX_CAMPAIGN_AUDIENCE = 50_000
/** Clientes leídos por página al calcular la audiencia (cursor por customer_id). */
export const AUDIENCE_PAGE_SIZE = 500
/** Destinatarios que `processCampaigns` prepara por llamada y campaña. */
export const CAMPAIGN_PAGE_SIZE = 200
/** Campañas distintas que una llamada de `processCampaigns` avanza a la vez. */
export const MAX_CAMPAIGNS_PER_RUN = 10
export const SAMPLE_SIZE = 20
/**
 * Cuándo se poda un enlace de baja sin usar (ms). No es una caducidad: la baja funciona con cualquier token que aún exista
 * (`marketing_unsubscribe` ya no comprueba `expires_at`), así que un correo antiguo sigue pudiendo darse de baja.
 */
export const UNSUBSCRIBE_TOKEN_RETENTION_MS = 730 * 86_400_000

export const OUTBOX_KIND_MESSAGE = 'marketing.campaign_message'
export const JOB_KIND_PROCESS = 'marketing.procesar_campana'

/**
 * Límites antiabuso de la baja pública (sin identidad). Solo los intentos fallidos (token o slug que no existe) cuentan
 * contra el slug, así una inundación de tokens falsos no impide darse de baja con uno válido; cada IP verificada tiene además
 * un límite propio por ventana.
 */
export interface UnsubscribeLimits { windowSeconds: number; failuresPerSlug: number; unknownSlug: number; perIp: number }
export const DEFAULT_UNSUBSCRIBE_LIMITS: Readonly<UnsubscribeLimits> = { windowSeconds: 60, failuresPerSlug: 60, unknownSlug: 30, perIp: 30 }
let unsubscribeLimits: UnsubscribeLimits = { ...DEFAULT_UNSUBSCRIBE_LIMITS }
export const getUnsubscribeLimits = (): Readonly<UnsubscribeLimits> => unsubscribeLimits
export function setUnsubscribeLimits(limits: Partial<UnsubscribeLimits> | null): void { unsubscribeLimits = { ...DEFAULT_UNSUBSCRIBE_LIMITS, ...(limits ?? {}) } }

/** Origen HTTPS de la web (enlaces de baja y de reservas). Por defecto `PUBLIC_APP_URL`; sin él, las operaciones que crean enlaces fallan. */
let publicOrigin: string | undefined
export function setPublicAppOrigin(origin: string | undefined): void { publicOrigin = origin }
export function publicAppOrigin(): string {
  const raw = publicOrigin ?? process.env.PUBLIC_APP_URL
  try {
    const url = new URL(raw ?? '')
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error()
    return url.origin
  } catch { throw new ApiError(412, 'failed-precondition', 'Falta el origen público de la aplicación (PUBLIC_APP_URL) para los enlaces de los mensajes.') }
}

/** Puerto con la fidelización: puntos por cliente para la regla `minPoints`. Lo enchufa el módulo de fidelización. */
export interface LoyaltyPointsPort { balances(client: PoolClient, restaurantId: string, customerIds: readonly string[]): Promise<ReadonlyMap<string, number>> }
let loyaltyPorts: LoyaltyPointsPort | null = null
export function setLoyaltyPointsPort(port: LoyaltyPointsPort | null): void { loyaltyPorts = port }
export function loyaltyPointsPort(): LoyaltyPointsPort {
  if (!loyaltyPorts) throw new ApiError(412, 'failed-precondition', 'Las reglas por puntos necesitan el módulo de fidelización, que aún no está conectado.')
  return loyaltyPorts
}

/** Puerto con las reservas (V3): cuántas reservas del periodo no tienen origen guardado. Por defecto 0 (ver README). */
export interface ReservationsWithoutOriginPort { count(client: PoolClient, restaurantId: string, locationIds: readonly string[], from: string, to: string): Promise<number> }
let withoutOriginPort: ReservationsWithoutOriginPort = { count: async () => 0 }
export function setReservationsWithoutOriginPort(port: ReservationsWithoutOriginPort | null): void { withoutOriginPort = port ?? { count: async () => 0 } }
export const reservationsWithoutOrigin = (): ReservationsWithoutOriginPort => withoutOriginPort
