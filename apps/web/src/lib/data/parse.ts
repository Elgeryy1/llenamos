/**
 * Lectura de documentos de Firestore con los esquemas de @llenamos/core.
 *
 * Si un documento no tiene la forma del contrato, no se rellena con valores
 * inventados: se lanza un DataShapeError que la interfaz enseña.
 */
import {
  ActivitySchema,
  AreaSchema,
  LocationSchema,
  MemberSchema,
  RestaurantSchema,
  RoleSchema,
  TableSchema,
  type Activity,
  type Area,
  type Location,
  type Member,
  type Restaurant,
  type Role,
  type Table,
} from "@llenamos/core"
import { z } from "zod"

export class DataShapeError extends Error {
  constructor(
    readonly path: string,
    readonly fields: string[],
  ) {
    super(
      fields.length > 0
        ? `Hay datos con un formato inesperado en ${path} (${fields.join(", ")}).`
        : `Hay datos con un formato inesperado en ${path}.`,
    )
    this.name = "DataShapeError"
  }
}

function parseWith<S extends z.ZodType>(schema: S, path: string, data: unknown): z.infer<S> {
  const result = schema.safeParse(data)
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => i.path.join(".") || "documento"))]
    throw new DataShapeError(path, fields)
  }
  return result.data
}

/** Marca de tiempo de Firestore (o cualquier cosa con toDate) a Date. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    const d: unknown = value.toDate()
    return d instanceof Date ? d : null
  }
  return null
}

/* users/{uid} ------------------------------------------------------------- */

const UserRestaurantSchema = z.object({ name: z.string(), role: RoleSchema })

const UserProfileSchema = z.object({
  displayName: z.string().optional(),
  email: z.string().optional(),
  restaurants: z.record(z.string(), UserRestaurantSchema).default({}),
})

export interface UserRestaurant {
  id: string
  name: string
  role: Role
}

export interface UserProfile {
  displayName: string | null
  restaurants: UserRestaurant[]
}

/** Un perfil que no existe todavía equivale a una persona sin restaurantes. */
export function parseUserProfile(id: string, data: unknown): UserProfile {
  if (data === undefined) return { displayName: null, restaurants: [] }
  const p = parseWith(UserProfileSchema, `users/${id}`, data)
  const restaurants = Object.entries(p.restaurants)
    .map(([rid, r]) => ({ id: rid, name: r.name, role: r.role }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"))
  return { displayName: p.displayName ?? null, restaurants }
}

/* restaurants/{rid} ------------------------------------------------------- */

export type RestaurantDoc = Restaurant & { id: string }

export function parseRestaurant(id: string, data: unknown): RestaurantDoc {
  if (data === undefined) throw new DataShapeError(`restaurants/${id}`, ["no existe"])
  return { id, ...parseWith(RestaurantSchema, `restaurants/${id}`, data) }
}

/* members/{uid} ----------------------------------------------------------- */

export type MemberDoc = Member

export function parseMember(id: string, data: unknown): MemberDoc | null {
  if (data === undefined) return null
  return parseWith(MemberSchema, `members/${id}`, data)
}

export function parseMemberStrict(id: string, data: unknown): MemberDoc {
  const m = parseMember(id, data)
  if (!m) throw new DataShapeError(`members/${id}`, ["no existe"])
  return m
}

/* locations, areas, tables ------------------------------------------------ */

export type LocationDoc = Location & { id: string }
export type AreaDoc = Area & { id: string }
export type TableDoc = Table & { id: string }

export function parseLocation(id: string, data: unknown): LocationDoc {
  return { id, ...parseWith(LocationSchema, `locations/${id}`, data) }
}

export function parseArea(id: string, data: unknown): AreaDoc {
  return { id, ...parseWith(AreaSchema, `areas/${id}`, data) }
}

export function parseTable(id: string, data: unknown): TableDoc {
  return { id, ...parseWith(TableSchema, `tables/${id}`, data) }
}

/* activity/{id} ----------------------------------------------------------- */

export type ActivityDoc = Activity & { id: string; createdAt: Date | null }

export function parseActivity(id: string, data: unknown): ActivityDoc {
  const parsed = parseWith(ActivitySchema, `activity/${id}`, data)
  const createdAt = data && typeof data === "object" && "createdAt" in data ? toDate(data.createdAt) : null
  return { id, ...parsed, createdAt }
}
