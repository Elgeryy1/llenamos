/**
 * Teléfonos en formato E.164: `+` y entre 8 y 15 cifras, sin espacios (`+34612345678`).
 *
 * Es el formato en el que se guardan (reservas, clientes, lista de espera) y con el que
 * se calcula el id del cliente, así que el mismo número escrito de dos formas tiene que
 * dar lo mismo: «612 34 56 78», «+34 612-345-678» y «0034 (612) 345678» → `+34612345678`.
 */
import { z } from "zod"

export const E164_REGEX = /^\+[1-9]\d{7,14}$/

export class InvalidPhoneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidPhoneError"
  }
}

/**
 * Pasa un teléfono escrito por una persona a E.164, o lanza `InvalidPhoneError` con un
 * mensaje que se puede enseñar.
 *
 * - Acepta espacios, guiones, puntos, barras y paréntesis.
 * - Con `+` o `00` delante, el número ya lleva su prefijo de país.
 * - Sin prefijo, se le pone `defaultCountryCode` (por defecto, España). Para España se
 *   comprueba que tenga 9 cifras y empiece por 6, 7, 8 o 9, y se acepta también escrito con
 *   el 34 delante sin `+` («34612345678»). En otros países se quita un 0 inicial de
 *   marcación nacional (salvo en Italia, donde forma parte del número).
 * - Es idempotente: un número ya en E.164 sale igual.
 */
export function normalizePhone(raw: string, defaultCountryCode = "34"): string {
  if (!/^[1-9]\d{0,2}$/.test(defaultCountryCode)) {
    throw new InvalidPhoneError(`Prefijo de país no válido: ${defaultCountryCode}.`)
  }
  const texto = raw.trim()
  if (texto === "") throw new InvalidPhoneError("Escribe un teléfono.")
  const limpio = texto.replace(/[\s\-./()]/g, "")
  if (!/^\+?\d+$/.test(limpio)) {
    throw new InvalidPhoneError("El teléfono solo puede llevar cifras, espacios, guiones, paréntesis y un + delante.")
  }

  let numero: string
  if (limpio.startsWith("+")) numero = limpio
  else if (limpio.startsWith("00")) numero = `+${limpio.slice(2)}`
  else if (defaultCountryCode === "34") {
    if (/^34[6-9]\d{8}$/.test(limpio)) numero = `+${limpio}`
    else if (/^[6-9]\d{8}$/.test(limpio)) numero = `+34${limpio}`
    else throw new InvalidPhoneError("Un teléfono de España tiene 9 cifras y empieza por 6, 7, 8 o 9. Si es de otro país, empieza por + y su prefijo.")
  } else {
    const nacional = defaultCountryCode !== "39" && limpio.startsWith("0") ? limpio.slice(1) : limpio
    numero = `+${defaultCountryCode}${nacional}`
  }

  if (!E164_REGEX.test(numero)) {
    throw new InvalidPhoneError("Ese teléfono no parece completo. Revisa las cifras y el prefijo del país.")
  }
  if (numero.startsWith("+34") && !/^\+34[6-9]\d{8}$/.test(numero)) {
    throw new InvalidPhoneError("Un teléfono de España tiene 9 cifras después del +34 y empieza por 6, 7, 8 o 9.")
  }
  return numero
}

/** Como `normalizePhone`, pero devuelve null en vez de lanzar. */
export function tryNormalizePhone(raw: string, defaultCountryCode = "34"): string | null {
  try {
    return normalizePhone(raw, defaultCountryCode)
  } catch {
    return null
  }
}

/** Teléfono ya guardado: tiene que estar en E.164. */
export const PhoneE164Schema = z.string().regex(E164_REGEX, "El teléfono debe estar en formato internacional (+34…).")

/**
 * Teléfono escrito por una persona (formularios y callables): se normaliza a E.164 con el
 * prefijo de España por defecto, y si no se entiende, el error explica por qué.
 */
export const PhoneInputSchema = z
  .string()
  .max(40, "El teléfono es demasiado largo.")
  .transform((raw, ctx) => {
    try {
      return normalizePhone(raw)
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Teléfono no válido." })
      return z.NEVER
    }
  })
