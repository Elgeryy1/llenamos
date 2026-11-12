/**
 * Forma de los datos en Firestore.
 *
 * restaurants/{rid}                         el negocio (un inquilino)
 *   members/{uid}                           quién trabaja ahí y con qué rol
 *   locations/{lid}                         cada local
 *     areas/{aid}                           zonas: sala, terraza…
 *     tables/{tid}                          mesas, con su sitio en el plano
 *   activity/{id}                           registro de actividad (solo lo escribe el servidor)
 * users/{uid}                               perfil de la persona y sus restaurantes
 */
import { z } from "zod"
import { ModuleOverridesSchema, ModuleSchema, PlanSchema } from "./modules"
import { ROLES } from "./roles"
import { TimestampSchema } from "./timestamp"

export const RoleSchema = z.enum(ROLES)

/** Idiomas de la interfaz pública, los mensajes y los clientes. */
export const LANGUAGES = ["es", "ca", "en"] as const
export type Language = (typeof LANGUAGES)[number]
export const LanguageSchema = z.enum(LANGUAGES)

export const LANGUAGE_LABEL: Record<Language, string> = {
  es: "Castellano",
  ca: "Català",
  en: "English",
}

/** Id de un documento de Firestore (sin barras). */
export const DocIdSchema = z.string().min(1).max(128).regex(/^[^/]+$/, "Id no válido.")

/** Identificador de URL: "taberna-lumbre". */
export const SlugSchema = z.string().min(1).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Usa solo minúsculas, cifras y guiones.")

/** Color de marca en hexadecimal: #f0a35e */
export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Usa un color como #f0a35e.")

export const RestaurantSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  brandColor: HexColorSchema,
  currency: z.literal("EUR"),
  timezone: z.literal("Europe/Madrid"),
  locale: LanguageSchema,
  isDemo: z.boolean(),
  /**
   * Plan y módulos (fase 1). Opcionales para no romper los restaurantes creados antes;
   * sin `plan` se trata como `completo` (ver `restaurantModules`). Solo los escribe el servidor.
   */
  plan: PlanSchema.optional(),
  moduleOverrides: ModuleOverridesSchema.optional(),
  activeModules: z.array(ModuleSchema).optional(),
  /** Proyección de acceso de fase 6, solo servidor. Ausente mantiene compatibilidad. */
  entitlementVersion: z.number().int().min(1).optional(),
  accessValidUntil: TimestampSchema.optional(),
  commercialPlanId: DocIdSchema.optional(),
  commercialPlanVersion: z.number().int().min(1).optional(),
})
export type Restaurant = z.infer<typeof RestaurantSchema>

export const MemberSchema = z.object({
  uid: z.string().min(1),
  displayName: z.string().trim().min(1).max(80),
  email: z.string().email(),
  role: RoleSchema,
  /** Locales a los que tiene acceso. Vacío = todos. */
  locationIds: z.array(z.string()),
  active: z.boolean(),
})
export type Member = z.infer<typeof MemberSchema>

export const LocationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  address: z.string().max(200),
  city: z.string().max(80),
  phone: z.string().max(30),
})
export type Location = z.infer<typeof LocationSchema>

export const AreaSchema = z.object({
  name: z.string().trim().min(1).max(40),
  sortOrder: z.number().int(),
})
export type Area = z.infer<typeof AreaSchema>

export const TableShapeSchema = z.enum(["rect", "round"])

/** Posición en el plano en una rejilla de 0 a 100 (porcentaje del ancho y alto de la zona). */
export const TableSchema = z.object({
  name: z.string().trim().min(1).max(20),
  areaId: z.string().min(1),
  seats: z.number().int().min(1).max(30),
  shape: TableShapeSchema,
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  w: z.number().min(2).max(100),
  h: z.number().min(2).max(100),
  /** Mesas con las que se puede juntar. */
  joinableWith: z.array(z.string()),
  enabled: z.boolean(),
})
export type Table = z.infer<typeof TableSchema>

export const ActivitySchema = z.object({
  action: z.string(),
  summary: z.string(),
  actorUid: z.string().nullable(),
  actorName: z.string().nullable(),
  entity: z.object({ type: z.string(), id: z.string() }).nullable(),
})
export type Activity = z.infer<typeof ActivitySchema>

/** Convierte un nombre en un identificador de URL: "Taberna Lumbre" → "taberna-lumbre". */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}
