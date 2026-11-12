/**
 * Comandos explícitos de reservas en el VPS que antes eran escrituras directas del navegador
 * (plano y ficha de cliente). La entrada es estricta; el UID y el rol salen siempre del token.
 */
import { z } from "zod"
import { CustomerEditableSchema } from "./reservation-model"
import { CustomerIdSchema } from "./ids"
import { AreaSchema, DocIdSchema, SlugSchema, TableSchema } from "./model"
import { PublicRestaurantSchema } from "./reservation-model"

export const CALLABLES_RESERVAS_VPS = {
  guardarPlano: "guardarPlano",
  editarCliente: "editarCliente",
  verRestaurantePublico: "verRestaurantePublico",
} as const

/** Como mucho tantas altas, cambios y bajas por guardado (igual que el límite del editor). */
export const PLANO_MAX_CAMBIOS = 500

export const GuardarPlanoInputSchema = z
  .strictObject({
    restaurantId: DocIdSchema,
    locationId: DocIdSchema,
    createAreas: z.array(AreaSchema.extend({ id: DocIdSchema })).default([]),
    updateAreas: z.array(AreaSchema.partial().extend({ id: DocIdSchema })).default([]),
    deleteAreas: z.array(DocIdSchema).default([]),
    createTables: z.array(TableSchema.extend({ id: DocIdSchema })).default([]),
    updateTables: z.array(TableSchema.partial().extend({ id: DocIdSchema })).default([]),
    deleteTables: z.array(DocIdSchema).default([]),
  })
  .refine(
    (v) => v.createAreas.length + v.updateAreas.length + v.deleteAreas.length + v.createTables.length + v.updateTables.length + v.deleteTables.length <= PLANO_MAX_CAMBIOS,
    "Demasiados cambios a la vez.",
  )
export const GuardarPlanoOutputSchema = z.object({ ok: z.literal(true) })

export const EditarClienteInputSchema = z.strictObject({
  restaurantId: DocIdSchema,
  customerId: CustomerIdSchema,
  ...CustomerEditableSchema.shape,
})
export const EditarClienteOutputSchema = z.object({ ok: z.literal(true) })

/** Sustituye a la lectura pública de `publicRestaurants/{slug}`: lo calcula la API desde SQL. */
export const VerRestaurantePublicoInputSchema = z.strictObject({ slug: SlugSchema })
export const VerRestaurantePublicoOutputSchema = PublicRestaurantSchema

export const CALLABLE_SCHEMAS_RESERVAS_VPS = {
  guardarPlano: { input: GuardarPlanoInputSchema, output: GuardarPlanoOutputSchema },
  editarCliente: { input: EditarClienteInputSchema, output: EditarClienteOutputSchema },
  verRestaurantePublico: { input: VerRestaurantePublicoInputSchema, output: VerRestaurantePublicoOutputSchema },
} as const
