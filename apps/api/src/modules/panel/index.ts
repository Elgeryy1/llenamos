import { z } from 'zod'
import { LocationSchema, MemberSchema, RestaurantSchema } from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { emitEvent } from '../../events.js'
import { restaurantContext } from '../../operations.js'
import type { ModuleDefinition } from '../types.js'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const ALL_ROLES = ['owner', 'manager', 'waiter', 'kitchen', 'bar'] as const
const ContextOutput = z.object({ restaurant: RestaurantSchema.extend({ id }), member: MemberSchema, locations: z.array(LocationSchema.extend({ id })) })
export const ContextInput = z.strictObject({ restaurantId: id })

/** Ajustes generales: lo único que owner y manager pueden cambiar del restaurante. */
export const SaveSettingsInput = z.strictObject({
  restaurantId: id,
  name: RestaurantSchema.shape.name.trim().min(2).max(80).optional(),
  brandColor: RestaurantSchema.shape.brandColor.optional(),
  locale: RestaurantSchema.shape.locale.optional(),
}).refine(value => value.name !== undefined || value.brandColor !== undefined || value.locale !== undefined, 'No hay ningún cambio.')

export const panelModule: ModuleDefinition = {
  name: 'panel',
  operations: [
    ['guardarAjustesRestaurante', {
      access: 'member', roles: ['owner', 'manager'], restaurantId: input => SaveSettingsInput.parse(input).restaurantId,
      input: SaveSettingsInput, output: z.object({ ok: z.literal(true) }),
      run: async (client, input) => {
        const data = SaveSettingsInput.parse(input)
        try {
          await client.query('SELECT llenamos.restaurant_settings_save($1,$2,$3,$4)', [data.restaurantId, data.name ?? null, data.brandColor?.toLowerCase() ?? null, data.locale ?? null])
        } catch (error) {
          const code = (error as { code?: string }).code
          if (code === '42501') throw new ApiError(403, 'permission-denied', 'No puedes cambiar los ajustes de este restaurante.')
          if (code === '22023') throw new ApiError(400, 'invalid-argument', 'Revisa el nombre, el color y el idioma.')
          if (code === 'P0002') throw new ApiError(404, 'not-found', 'No se encuentra el restaurante.')
          throw error
        }
        await emitEvent(client, { restaurantId: data.restaurantId, topic: 'ajustes.restaurante' })
        return { ok: true as const }
      },
    }],
  ],
  liveQueries: [{
    name: 'contextoRestaurante', roles: ALL_ROLES, input: ContextInput, output: ContextOutput,
    restaurantId: input => ContextInput.parse(input).restaurantId,
    topics: () => ['ajustes.restaurante', 'equipo.miembro', 'plataforma.restaurante'],
    // Plan y módulos los cambia plataforma, que no puede emitir eventos del interior del restaurante.
    refreshMs: 30_000,
    snapshot: (client, input, { uid }) => restaurantContext(client, uid, ContextInput.parse(input).restaurantId),
  }],
}
