/**
 * Lectura de `publicRestaurants/{slug}` desde el servidor de Next por la API del VPS, para que la página llegue con
 * el nombre, el color y los locales ya pintados. La lectura REST de Firestore de la demo vive en `restaurante-demo.ts`.
 */
import { PublicRestaurantSchema, SlugSchema, type PublicRestaurant } from "@llenamos/core"

export type PublicRestaurantResult =
  | { status: "ok"; restaurant: PublicRestaurant }
  | { status: "not_found" }
  /** El documento existe pero no encaja con el contrato: se dice, no se rellena. */
  | { status: "invalid"; problems: string[] }
  /** No hay configuración o Firestore no responde. */
  | { status: "unavailable"; detail: string }

/** Valida lo leído con el esquema de core y dice qué campos fallan. */
export function parsePublicRestaurant(data: unknown): PublicRestaurantResult {
  const parsed = PublicRestaurantSchema.safeParse(data)
  if (parsed.success) return { status: "ok", restaurant: parsed.data }
  return {
    status: "invalid",
    problems: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "documento"}: ${i.message}`),
  }
}

/**
 * Lectura de la proyección pública por la API del VPS (el servidor de Next llega a la API por la red interna).
 * `API_INTERNAL_ORIGIN` es obligatorio en producción; no se toma nada de la petición del visitante.
 */
export async function fetchPublicRestaurantFromApi(
  slug: string,
  origin: string | undefined = process.env.API_INTERNAL_ORIGIN,
  fetcher: typeof fetch = fetch,
): Promise<PublicRestaurantResult> {
  if (!SlugSchema.safeParse(slug).success) return { status: "not_found" }
  if (!origin || !/^https?:\/\/[^/\s]+$/.test(origin)) return { status: "unavailable", detail: "Falta API_INTERNAL_ORIGIN." }
  let response: Response
  try {
    response = await fetcher(`${origin}/v1/operations/verRestaurantePublico`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { slug } }),
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    })
  } catch {
    return { status: "unavailable", detail: "La API no responde." }
  }
  if (response.status === 404) return { status: "not_found" }
  if (!response.ok) return { status: "unavailable", detail: `La API respondió ${response.status}.` }
  const body = (await response.json().catch(() => null)) as { result?: unknown } | null
  return parsePublicRestaurant(body?.result)
}
