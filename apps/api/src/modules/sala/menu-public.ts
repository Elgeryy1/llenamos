import { z } from 'zod'
import * as core from '@llenamos/core'
import type { Operation } from '../../operations.js'
import { ApiError } from '../../errors.js'
import type { Scope } from './context.js'
import { restaurantView } from './context.js'

/**
 * Carta pública del local (antes el documento `publicMenus` de Firestore). Es la misma proyección
 * `buildPublicMenu` que ya consume la web; no lleva credenciales. Lee solo las tablas de carta, sin
 * bloqueo de servicio, y se guarda unos segundos en memoria para que el sondeo de muchos móviles no
 * se convierta en consultas: el coste por local es una lectura cada `TTL`.
 */
export const VerCartaPublicaInput = z.strictObject({ slug: core.SlugSchema, locationId: core.DocIdSchema })
const TTL_MS = 15_000
const cache = new Map<string, { at: number; menu: z.output<typeof core.PublicMenuSchema> }>()
export function clearMenuCache() { cache.clear() }

export const verCartaPublica: Operation = {
  access: 'public', input: VerCartaPublicaInput, output: core.PublicMenuSchema,
  async runPublic(raw, { pool, clientIp }) {
    const d = VerCartaPublicaInput.parse(raw)
    const key = `${d.slug}/${d.locationId}`, hit = cache.get(key)
    // Por IP y no por restaurante: un sondeo masivo de una IP no deja sin carta a los demás comensales.
    const { rows: limit } = await pool.query<{ ok: boolean }>('SELECT llenamos.sala_rate_limit($1,$2,60) AS ok', [core.sha256Hex(JSON.stringify(['carta', clientIp ?? 'sin-ip'])), clientIp ? 120 : 600])
    if (!limit[0]?.ok) throw new ApiError(429, 'resource-exhausted', 'Demasiadas solicitudes. Espera un momento antes de volver a intentarlo.')
    if (hit && Date.now() - hit.at < TTL_MS) return hit.menu
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const scope = (await client.query<{ s: Scope | null }>('SELECT llenamos.sala_public_scope($1,$2) AS s', [d.slug, d.locationId])).rows[0]?.s
      if (!scope) throw new ApiError(404, 'not-found', 'No se encuentra la carta.')
      const restaurant = scope.restaurant as Record<string, any>, location = scope.location as Record<string, any>
      const read = async (table: string) => (await client.query<{ id: string; doc: unknown }>(`SELECT id,doc FROM llenamos.${table} WHERE restaurant_id=$1 AND location_id=$2`, [restaurant.id, d.locationId])).rows
      const floor = (await client.query<{ doc: unknown }>("SELECT doc FROM llenamos.sala_settings WHERE restaurant_id=$1 AND location_id=$2 AND kind='floor'", [restaurant.id, d.locationId])).rows[0]
      // La zona horaria sale de los ajustes de reservas, la misma fuente que usa el resto de sala.
      const reservations = (await client.query<{ data: unknown }>('SELECT data FROM llenamos.reservation_settings WHERE restaurant_id=$1 AND location_id=$2', [restaurant.id, d.locationId])).rows[0]
      const byId = <T>(rows: { id: string; doc: unknown }[], schema: z.ZodType<T>) => Object.fromEntries(rows.map(r => [r.id, schema.parse(r.doc)]))
      const menu = core.buildPublicMenu({
        restaurantId: restaurant.id, locationId: d.locationId, restaurantName: restaurant.name, locationName: location.name, brandColor: restaurant.brand_color,
        timezone: reservations ? core.ReservationSettingsSchema.parse(reservations.data).timezone : restaurant.timezone,
        settings: floor ? core.FloorSettingsSchema.parse(floor.doc) : core.defaultFloorSettings(),
        categories: byId(await read('sala_menu_categories'), core.MenuCategorySchema), items: byId(await read('sala_menu_items'), core.MenuItemSchema),
        dailyMenus: byId(await read('sala_daily_menus'), core.DailyMenuSchema), floorModule: core.hasModule(restaurantView(restaurant), 'floor'),
      })
      await client.query('COMMIT')
      cache.set(key, { at: Date.now(), menu })
      if (cache.size > 500) cache.delete(cache.keys().next().value!)
      return menu
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally { client.release() }
  },
}
