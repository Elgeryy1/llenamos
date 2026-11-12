/**
 * SOLO DEMO (emuladores): lectura de `publicRestaurants/{slug}` por la API REST de Firestore. Se carga con
 * `cargarRestauranteDemo()` (guarda en línea): el bundle de producción `postgres` no lo contiene.
 */
import { SlugSchema } from "@llenamos/core"
import type { FirebaseSettings } from "@/lib/firebase/config"
import { parsePublicRestaurant, type PublicRestaurantResult } from "./restaurante"

/* Valores de la API REST ------------------------------------------------------ */

type RestValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { bytesValue: string }
  | { referenceValue: string }
  | { geoPointValue: { latitude: number; longitude: number } }
  | { arrayValue: { values?: RestValue[] } }
  | { mapValue: { fields?: Record<string, RestValue> } }

/** Convierte un valor de la API REST de Firestore en un valor normal de JavaScript. */
export function decodeValue(value: RestValue): unknown {
  if ("nullValue" in value) return null
  if ("booleanValue" in value) return value.booleanValue
  if ("integerValue" in value) return Number(value.integerValue)
  if ("doubleValue" in value) return Number(value.doubleValue)
  if ("timestampValue" in value) return Date.parse(value.timestampValue)
  if ("stringValue" in value) return value.stringValue
  if ("bytesValue" in value) return value.bytesValue
  if ("referenceValue" in value) return value.referenceValue
  if ("geoPointValue" in value) return value.geoPointValue
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(decodeValue)
  if ("mapValue" in value) return decodeFields(value.mapValue.fields ?? {})
  return undefined
}

export function decodeFields(fields: Record<string, RestValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decodeValue(v)]))
}

/* Dirección del documento ------------------------------------------------------ */

export function documentUrl(settings: FirebaseSettings, path: string): string {
  const projectId = settings.options.projectId ?? ""
  const base = settings.emulators
    ? `http://${settings.emulators.host}:${settings.emulators.ports.firestore}`
    : "https://firestore.googleapis.com"
  const url = `${base}/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${path}`
  return settings.emulators || !settings.options.apiKey ? url : `${url}?key=${encodeURIComponent(settings.options.apiKey)}`
}

export async function fetchPublicRestaurant(
  slug: string,
  settings: FirebaseSettings | null,
  fetcher: typeof fetch = fetch,
): Promise<PublicRestaurantResult> {
  if (!SlugSchema.safeParse(slug).success) return { status: "not_found" }
  if (!settings) return { status: "unavailable", detail: "Firebase no está configurado en la web." }
  let response: Response
  try {
    response = await fetcher(documentUrl(settings, `publicRestaurants/${slug}`), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    })
  } catch (error) {
    return { status: "unavailable", detail: error instanceof Error ? error.message : "Sin respuesta de Firestore." }
  }
  if (response.status === 404) return { status: "not_found" }
  if (!response.ok) return { status: "unavailable", detail: `Firestore ha respondido ${response.status}.` }
  const body = (await response.json().catch(() => null)) as { fields?: Record<string, RestValue> } | null
  if (!body) return { status: "unavailable", detail: "Respuesta de Firestore no válida." }
  return parsePublicRestaurant(decodeFields(body.fields ?? {}))
}
