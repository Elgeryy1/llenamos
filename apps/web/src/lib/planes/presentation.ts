import type { Subscription } from '@llenamos/core'
export const SUBSCRIPTION_LABEL: Record<Subscription['status'], string> = { not_configured: 'Facturación sin configurar', trialing: 'Prueba gratuita', active: 'Suscripción al día', past_due: 'Pago pendiente', suspended: 'Servicio suspendido', cancelled: 'Suscripción dada de baja' }
export const formatMoney = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(cents/100)
export const formatDate = (date: number | null) => date === null ? 'Sin fecha' : new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeZone: 'Europe/Madrid' }).format(date)
