/** Proveedores que cada restaurante conecta con sus propias claves, y cómo se explican en la pantalla. */
import { CAMPOS_VACIABLES, type RestaurantIntegrationsInput, type RestaurantProviderSchema } from "@llenamos/core"
import type { z } from "zod"

export type Proveedor = z.infer<typeof RestaurantProviderSchema>

export interface Campo {
  key: string
  label: string
  /** Las claves y secretos no se enseñan nunca: el campo es de contraseña y queda vacío. */
  secret: boolean
  hint?: string
}

export interface FichaProveedor {
  id: Proveedor
  title: string
  description: string
  fields: readonly Campo[]
}

export const PROVEEDORES: readonly FichaProveedor[] = [
  {
    id: "stripe",
    title: "Stripe",
    description: "Cobros con tu propia cuenta de Stripe: la señal de las reservas y los cobros con el móvil. El dinero va directo a tu cuenta.",
    fields: [
      { key: "secretKey", label: "Clave secreta", secret: true, hint: "Empieza por sk_ o rk_." },
      { key: "webhookSecret", label: "Secreto del webhook", secret: true, hint: "Empieza por whsec_. Se crea al añadir el webhook en Stripe." },
      { key: "mobileWebhookSecret", label: "Secreto del webhook de cobros con el móvil", secret: true, hint: "Opcional." },
      { key: "accountId", label: "Identificador de la cuenta", secret: false, hint: "Opcional. Empieza por acct_." },
    ],
  },
  {
    id: "whatsapp",
    title: "WhatsApp",
    description: "Avisos a tus clientes desde tu número de WhatsApp Business.",
    fields: [
      { key: "token", label: "Token de acceso", secret: true },
      { key: "phoneNumberId", label: "Identificador del número", secret: false },
      { key: "appSecret", label: "Secreto de la aplicación", secret: true },
      { key: "verifyToken", label: "Token de verificación del webhook", secret: true, hint: "Lo eliges tú y lo repites en Meta." },
      { key: "templateTakeawayAccepted", label: "Plantilla de pedido aceptado", secret: false, hint: "Opcional." },
      { key: "templateTakeawayReady", label: "Plantilla de pedido listo", secret: false, hint: "Opcional." },
    ],
  },
  {
    id: "email",
    title: "Correo",
    description: "Avisos por correo con tu cuenta de Resend y tu dirección de envío.",
    fields: [
      { key: "apiKey", label: "Clave de la API", secret: true },
      { key: "from", label: "Remitente", secret: false, hint: "Por ejemplo, Casa Lola <reservas@casalola.es>." },
    ],
  },
  {
    id: "fiscal",
    title: "Facturación fiscal",
    description: "La integración fiscal es con el proveedor que contrates tú: el cumplimiento fiscal es del restaurante y LogiQD solo te ayuda a configurarla.",
    fields: [
      { key: "provider", label: "Proveedor fiscal", secret: false },
      { key: "apiKey", label: "Clave de la API", secret: true },
    ],
  },
  {
    id: "repite",
    title: "Repite",
    description: "Tarjeta de fidelización Repite, con tu comercio.",
    fields: [
      { key: "apiKey", label: "Clave de la API", secret: true },
      { key: "merchantId", label: "Identificador del comercio", secret: false },
    ],
  },
]

export type Estado = { configured: boolean; status: "not_configured" | "configured" | "adapter_pending" }

export function etiquetaEstado(estado: Estado): string {
  if (!estado.configured) return "Sin configurar"
  return estado.status === "adapter_pending" ? "Guardado, aún sin conexión activa" : "Configurado"
}

/** ¿Se puede vaciar este campo sin quitar el proveedor entero? (opcionales; lo decide el servidor, aquí solo se ofrece el botón) */
export function esVaciable(provider: Proveedor, field: string): boolean {
  return ((CAMPOS_VACIABLES as Record<string, readonly string[]>)[provider] ?? []).includes(field)
}

/** Solo los campos que la persona ha rellenado; vacío conserva lo guardado. */
export function cambiosDeFormulario(ficha: FichaProveedor, valores: Record<string, string>): RestaurantIntegrationsInput {
  const cambios = Object.fromEntries(ficha.fields.flatMap((f) => (valores[f.key]?.trim() ? [[f.key, valores[f.key]!.trim()]] : [])))
  return Object.keys(cambios).length > 0 ? ({ [ficha.id]: cambios } as RestaurantIntegrationsInput) : {}
}

/** Dirección que el restaurante copia en Stripe o Meta; incluye su identificador, sin el cual el servidor la rechaza. */
export function urlWebhook(origin: string, provider: "stripe" | "whatsapp", restaurantId: string): string {
  return `${origin}/api/v1/webhooks/${provider}/${encodeURIComponent(restaurantId)}`
}
