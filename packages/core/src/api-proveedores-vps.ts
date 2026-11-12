/**
 * Claves de los proveedores del propio restaurante (Stripe, WhatsApp, correo, fiscal y Repite) en el VPS.
 * Las pone el propietario desde su configuración y se guardan cifradas en la bóveda del restaurante.
 * Solo se devuelven estados y los nombres de los campos guardados, nunca los valores.
 */
import { z } from "zod"
import { DocIdSchema } from "./model"
import {
  RestaurantIntegrationsInputSchema,
  RestaurantIntegrationStatusSchema,
  RestaurantProviderSchema,
} from "./integraciones-proveedores"

export const CALLABLES_PROVEEDORES_VPS = {
  verProveedoresRestaurante: "verProveedoresRestaurante",
  guardarProveedoresRestaurante: "guardarProveedoresRestaurante",
} as const

export const VerProveedoresRestauranteInputSchema = z.strictObject({ restaurantId: DocIdSchema })

/** Estado de cada proveedor y qué campos tiene guardados (solo los nombres). */
export const ProveedoresRestauranteOutputSchema = z.object({
  providers: RestaurantIntegrationStatusSchema,
  savedFields: z.record(RestaurantProviderSchema, z.array(z.string().max(60)).max(20)),
})

/** Campos opcionales que se pueden vaciar sin quitar el proveedor entero. */
export const CAMPOS_VACIABLES = {
  stripe: ["mobileWebhookSecret", "accountId"],
  whatsapp: ["templateTakeawayAccepted", "templateTakeawayReady"],
} as const satisfies Partial<Record<z.infer<typeof RestaurantProviderSchema>, readonly string[]>>

const REMITENTE = /^(?:[^<>@\r\n]+<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/
/** Formato de lo que se escribe; lo ya guardado (que viene de plataforma) no se revalida. */
const FORMATOS: ReadonlyArray<readonly [provider: "stripe" | "whatsapp" | "email", field: string, test: RegExp, message: string]> = [
  ["stripe", "secretKey", /^(?:sk|rk)_[A-Za-z0-9_]{8,}$/, "La clave secreta de Stripe empieza por sk_ o rk_."],
  ["stripe", "webhookSecret", /^whsec_[A-Za-z0-9_]{8,}$/, "El secreto del webhook de Stripe empieza por whsec_."],
  ["stripe", "mobileWebhookSecret", /^whsec_[A-Za-z0-9_]{8,}$/, "El secreto del webhook de Stripe empieza por whsec_."],
  ["stripe", "accountId", /^acct_[A-Za-z0-9]{6,}$/, "El identificador de la cuenta de Stripe empieza por acct_."],
  ["email", "from", REMITENTE, "El remitente debe ser un correo o «Nombre <correo>»."],
]

/** Un campo vacío conserva el valor guardado; `clear` vacía campos opcionales y `remove` quita el proveedor entero. */
export const GuardarProveedoresRestauranteInputSchema = z
  .strictObject({
    restaurantId: DocIdSchema,
    integrations: RestaurantIntegrationsInputSchema.default({}),
    remove: z.array(RestaurantProviderSchema).max(5).default([]),
    clear: z.array(z.strictObject({ provider: RestaurantProviderSchema, field: z.string().max(60) })).max(10).default([]),
  })
  .superRefine((value, ctx) => {
    for (const [provider, field, test, message] of FORMATOS) {
      const written = (value.integrations[provider] as Record<string, string | undefined> | undefined)?.[field]?.trim()
      if (written && !test.test(written)) ctx.addIssue({ code: "custom", path: ["integrations", provider, field], message })
    }
    value.clear.forEach(({ provider, field }, index) => {
      const allowed = (CAMPOS_VACIABLES as Record<string, readonly string[]>)[provider] ?? []
      if (!allowed.includes(field)) ctx.addIssue({ code: "custom", path: ["clear", index], message: "Ese campo no se puede vaciar por separado." })
    })
  })

export const CALLABLE_SCHEMAS_PROVEEDORES_VPS = {
  verProveedoresRestaurante: { input: VerProveedoresRestauranteInputSchema, output: ProveedoresRestauranteOutputSchema },
  guardarProveedoresRestaurante: { input: GuardarProveedoresRestauranteInputSchema, output: ProveedoresRestauranteOutputSchema },
} as const
