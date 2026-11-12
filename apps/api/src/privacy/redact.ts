import { randomBytes } from 'node:crypto'

/**
 * Identificador de 20 hex que sustituye a la persona en lo que se conserva. Es ALEATORIO en cada borrado: derivarlo de
 * la persona (o de su hash) permitiría volver a ligar lo anonimizado con solo conocer el teléfono.
 */
export const newTombstone = () => randomBytes(10).toString('hex')
/** Teléfono sustituto distinto por borrado (prefijo +34000 no asignado): ninguna ficha se junta por un teléfono común. */
export const tombstonePhone = (tombstone: string) => `+34000${String(parseInt(tombstone.slice(0, 8), 16) % 1_000_000).padStart(6, '0')}`

const CLEAR_TEXT = new Set(['notes', 'guestNotes', 'note', 'allergies', 'cancelReason', 'reason'])
const NAMES = new Set(['guestName', 'name', 'waiterName'])

/**
 * Anonimiza un documento de reserva, cliente, espera, sesión o recogida sin cambiar su forma ni sus importes:
 * nombre, teléfono, correo y notas se sustituyen por valores válidos que no identifican a nadie.
 * `keep` lista claves que no se tocan (p. ej. `name` de un plato).
 */
export function redactDoc<T>(value: T, tombstone: string, keep: readonly string[] = []): T {
  const phone = tombstonePhone(tombstone)
  const clean = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(clean)
    if (!item || typeof item !== 'object') return item
    return Object.fromEntries(Object.entries(item).map(([key, v]) => {
      if (keep.includes(key)) return [key, v]
      if (key === 'customerId' && typeof v === 'string' && v) return [key, tombstone]
      if (key === 'phone') return [key, typeof v === 'string' ? phone : v]
      if (key === 'email') return [key, null]
      if (NAMES.has(key) && typeof v === 'string') return [key, 'Persona suprimida']
      if (CLEAR_TEXT.has(key) && typeof v === 'string') return [key, '']
      if (key === 'tags' && Array.isArray(v)) return [key, []]
      if (['manageTokenHash', 'tokenHash', 'offerTokenHash'].includes(key) && typeof v === 'string') return [key, '0'.repeat(64)]
      return [key, clean(v)]
    }))
  }
  return { ...(clean(value) as object), privacyRedacted: true } as T
}
