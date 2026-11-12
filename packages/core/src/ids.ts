/**
 * Identificadores estables: id del cliente, referencia de la reserva y tokens de enlace.
 *
 * Nada de aquí lee el azar por su cuenta: los bytes aleatorios entran como parámetro
 * (`crypto.getRandomValues` en el navegador, `randomBytes` en Node), así las funciones
 * son puras y se pueden probar.
 */
import { z } from "zod"
import { E164_REGEX } from "./phone"
import { sha256Hex } from "./sha256"

/**
 * Id del documento `customers/{cid}`: los 20 primeros caracteres hexadecimales (80 bits)
 * del SHA-256 de `"{restaurantId}:{phoneE164}"`.
 *
 * Por qué SHA-256 y no un hash más corto: es estándar, sale igual en cualquier entorno, y
 * con 80 bits la probabilidad de que dos teléfonos del mismo restaurante choquen es
 * despreciable (haría falta del orden de un billón de clientes). Incluir el restaurante
 * hace que el mismo teléfono tenga un id distinto en cada restaurante, y no se puede
 * sacar el teléfono a partir del id sin probar números uno a uno.
 */
export function customerIdFor(restaurantId: string, phoneE164: string): string {
  if (restaurantId.length === 0) throw new Error("Falta el id del restaurante.")
  if (!E164_REGEX.test(phoneE164)) throw new Error(`El teléfono ${phoneE164} no está en formato E.164.`)
  return sha256Hex(`${restaurantId}:${phoneE164}`).slice(0, 20)
}

export const CustomerIdSchema = z.string().regex(/^[0-9a-f]{20}$/, "Id de cliente no válido.")

/**
 * Alfabeto de las referencias: cifras del 2 al 9 y letras mayúsculas sin I, L ni O
 * (31 caracteres). Fuera el 0, el 1, la O, la I y la L, que se confunden al dictarlas o leerlas.
 */
export const REFERENCE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
export const REFERENCE_LENGTH = 6

/** Mayor múltiplo de 31 que cabe en un byte: los bytes desde aquí se descartan para no sesgar. */
const LIMITE_SIN_SESGO = Math.floor(256 / REFERENCE_ALPHABET.length) * REFERENCE_ALPHABET.length

/**
 * Referencia de 6 caracteres a partir de bytes aleatorios (`"K7M2QX"`).
 *
 * Cada byte da un carácter con `byte % 31`; los bytes de 248 en adelante se saltan para
 * que todos los caracteres salgan con la misma probabilidad. Pasa 16 bytes: con 6 sobra
 * casi siempre, pero si se descartan demasiados se lanza un error en vez de inventar.
 * Hay unos 887 millones de referencias posibles; la unicidad por restaurante la comprueba
 * quien la guarda (y prueba con otros bytes si ya existe).
 */
export function reservationReference(randomBytes: Uint8Array): string {
  let ref = ""
  for (const byte of randomBytes) {
    if (byte >= LIMITE_SIN_SESGO) continue
    ref += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length]
    if (ref.length === REFERENCE_LENGTH) return ref
  }
  throw new Error(`Faltan bytes aleatorios para la referencia: pasa al menos 16.`)
}

const REFERENCE_REGEX = new RegExp(`^[${REFERENCE_ALPHABET}]{${REFERENCE_LENGTH}}$`)

/** Referencia guardada: exactamente 6 caracteres del alfabeto. */
export const ReservationReferenceSchema = z.string().regex(REFERENCE_REGEX, "Referencia de reserva no válida.")

/**
 * Referencia escrita por una persona: quita espacios y guiones y pasa a mayúsculas
 * («k7m-2qx» → «K7M2QX»). No corrige letras confusas: si alguien escribe una O, no existe.
 */
export function normalizeReference(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase()
}

/** Referencia de entrada en las callables: se normaliza y luego se valida. */
export const ReservationReferenceInputSchema = z
  .string()
  .max(20, "Referencia de reserva no válida.")
  .transform(normalizeReference)
  .pipe(ReservationReferenceSchema)

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/**
 * Token secreto para un enlace (gestionar la reserva, aceptar una oferta de lista de
 * espera) a partir de bytes aleatorios, en base64url sin relleno. Con 32 bytes salen 43
 * caracteres. Solo va en el enlace; en Firestore se guarda su `sha256Hex`.
 */
export function linkToken(randomBytes: Uint8Array): string {
  if (randomBytes.length < 16) throw new Error("Un token de enlace necesita al menos 16 bytes aleatorios.")
  let bits = 0
  let acumulado = 0
  let token = ""
  for (const byte of randomBytes) {
    acumulado = (acumulado << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      token += BASE64URL[(acumulado >> bits) & 63]
    }
    acumulado &= (1 << bits) - 1
  }
  if (bits > 0) token += BASE64URL[(acumulado << (6 - bits)) & 63]
  return token
}

/** Token de enlace recibido en una callable. */
export const LinkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/, "El enlace no es válido.")

/** Hash guardado de un token (`manageTokenHash`, `offer.tokenHash`): SHA-256 en hexadecimal. */
export const TokenHashSchema = z.string().regex(/^[0-9a-f]{64}$/, "Hash no válido.")
