/**
 * Errores de las callables públicas → mensaje en el idioma de la página.
 *
 * Las funciones mandan mensajes en castellano pensados para enseñarse. Los conocidos se
 * traducen; uno desconocido se enseña tal cual en castellano y, en otro idioma, se usa
 * el genérico de su código.
 */
import type { Language } from "@llenamos/core"
import { ZodError } from "zod"
import { PublicCallError } from "./callables"
import type { TextKey, Translate } from "./i18n"

/** Mensajes del servidor (R1 y R2) que tienen traducción. Se comparan sin mayúsculas ni puntos. */
const KNOWN_MESSAGES: Array<[RegExp, TextKey]> = [
  [/franja ya no est[aá] disponible/, "errSlotTaken"],
  [/no queda sitio/, "errSlotTaken"],
  [/las mesas elegidas no est[aá]n disponibles/, "errSlotTaken"],
  [/esa hora no existe/, "errSlotTaken"],
  [/no acepta reservas por la web/, "errBookingOff"],
  [/m[oó]dulo de reservas est[aá] desactivado/, "errModuleOff"],
  [/no se encuentra el (restaurante|local)/, "errNotFound"],
  [/enlace de reserva no es v[aá]lido/, "errInvalidLink"],
  [/no se encuentra la reserva/, "errInvalidLink"],
  [/oferta ha caducado/, "errOfferExpired"],
  [/no se encuentra la oferta/, "errOfferExpired"],
  [/hueco ya no est[aá] disponible/, "errOfferGone"],
  [/lista de espera est[aá] desactivada/, "errWaitlistOff"],
  [/fuera del plazo de reservas/, "errOutOfRange"],
  [/no se puede confirmar/, "errCannotConfirm"],
  [/revisa los datos/, "errInvalidData"],
]

const BY_CODE: Partial<Record<PublicCallError["code"], TextKey>> = {
  "resource-exhausted": "errTooMany",
  network: "errNetwork",
  "deadline-exceeded": "errTimeout",
  unavailable: "errNetwork",
  "not-deployed": "errNotDeployed",
  "not-found": "errNotFound",
  "permission-denied": "errInvalidLink",
  "invalid-argument": "errInvalidData",
  aborted: "errGeneric",
}

export interface ShownError {
  /** Clave del mensaje traducido, si se ha reconocido. */
  key: TextKey | null
  message: string
  code: string
}

export function describePublicError(error: unknown, lang: Language, t: Translate): ShownError {
  if (error instanceof ZodError) return { key: "errInvalidData", message: t("errInvalidData"), code: "validation" }
  if (!(error instanceof PublicCallError)) return { key: "errGeneric", message: t("errGeneric"), code: "unknown" }

  const text = error.message.toLowerCase()
  const known = KNOWN_MESSAGES.find(([pattern]) => pattern.test(text))
  if (known) return { key: known[1], message: t(known[1]), code: error.code }

  // Un mensaje del servidor que no conocemos: en castellano se enseña tal cual.
  const ownMessage = error.code !== "internal" && error.code !== "config" && error.message.trim() !== ""
  if (lang === "es" && ownMessage && !["network", "deadline-exceeded", "not-deployed"].includes(error.code)) {
    return { key: null, message: error.message, code: error.code }
  }
  const key = BY_CODE[error.code] ?? "errGeneric"
  return { key, message: t(key), code: error.code }
}

/** ¿El error dice que la hora elegida ya no vale? Entonces se vuelven a pedir las horas. */
export function isSlotGone(shown: ShownError): boolean {
  return shown.key === "errSlotTaken"
}
