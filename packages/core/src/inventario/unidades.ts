/**
 * Unidades y cantidades del almacén.
 *
 * Toda cantidad guardada es un entero en la unidad base del ingrediente: gramos (`g`), mililitros
 * (`ml`) o unidades (`u`). Nunca hay decimales flotantes. Se pueden escribir y mostrar en kg, cl
 * o l, pero se convierten a base y deben salir exactas. No se mezclan familias (masa, volumen,
 * unidades): 1 kg de aceite no se convierte en litros porque eso exige una densidad.
 */
import { z } from "zod"

export const UNITS = ["g", "kg", "ml", "cl", "l", "u"] as const
export type Unit = (typeof UNITS)[number]
export const UnitSchema = z.enum(UNITS)
export const BASE_UNITS = ["g", "ml", "u"] as const
export type BaseUnit = (typeof BASE_UNITS)[number]
export const BaseUnitSchema = z.enum(BASE_UNITS)

export const UNIT_LABEL: Record<Unit, string> = { g: "g", kg: "kg", ml: "ml", cl: "cl", l: "l", u: "ud" }
export type UnitFamily = "mass" | "volume" | "count"

const INFO: Record<Unit, { family: UnitFamily; base: BaseUnit; factor: number }> = {
  g: { family: "mass", base: "g", factor: 1 },
  kg: { family: "mass", base: "g", factor: 1000 },
  ml: { family: "volume", base: "ml", factor: 1 },
  cl: { family: "volume", base: "ml", factor: 10 },
  l: { family: "volume", base: "ml", factor: 1000 },
  u: { family: "count", base: "u", factor: 1 },
}

export const familyOf = (unit: Unit): UnitFamily => INFO[unit].family
export const baseUnitOf = (unit: Unit): BaseUnit => INFO[unit].base
export const areCompatibleUnits = (a: Unit, b: Unit): boolean => INFO[a].family === INFO[b].family

/** Cuántas unidades base tiene una unidad (kg = 1000 g). */
export const unitFactor = (unit: Unit): number => INFO[unit].factor

/** Convierte una cantidad entera de una unidad a su unidad base. Falla si no cabe en un entero seguro. */
export function toBase(quantity: number, unit: Unit): number {
  if (!Number.isSafeInteger(quantity)) throw new Error("La cantidad debe ser un entero.")
  const base = quantity * INFO[unit].factor
  if (!Number.isSafeInteger(base)) throw new Error("La cantidad es demasiado grande.")
  return base
}

/**
 * Lee una cantidad escrita por una persona («250 g», «1,5 kg», «2 l», «3») y la devuelve en la
 * unidad base pedida, o null si no se entiende, si mezcla familias o si no sale entera (0,5 g).
 * Sin unidad escrita se usa la base. La coma y el punto valen como separador decimal.
 */
export function parseQuantity(text: string, base: BaseUnit): number | null {
  const m = /^\s*(\d+)(?:[.,](\d{1,9}))?\s*([a-zA-Z]*)\s*$/.exec(text)
  if (!m) return null
  const sufijo = (m[3] ?? "").toLowerCase()
  const unidad = sufijo === "" ? base : sufijo === "ud" || sufijo === "uds" ? "u" : (UNITS as readonly string[]).includes(sufijo) ? (sufijo as Unit) : null
  if (unidad === null || INFO[unidad].base !== base) return null
  const decimales = m[2] ?? ""
  const numerador = BigInt(`${m[1]}${decimales}`) * BigInt(INFO[unidad].factor)
  const divisor = BigInt(10) ** BigInt(decimales.length)
  if (numerador % divisor !== BigInt(0)) return null
  const resultado = numerador / divisor
  return resultado <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(resultado) : null
}

function decimalEntero(entero: number, divisor: number): string {
  const e = Math.floor(entero / divisor)
  const resto = entero % divisor
  if (resto === 0) return String(e)
  const digitos = String(divisor).length - 1
  return `${e},${String(resto).padStart(digitos, "0").replace(/0+$/, "")}`
}

/** Texto para mostrar: 850 g, 1,25 kg, 750 ml, 2 l, 12 ud. Los negativos llevan signo. */
export function formatQuantity(base: number, unit: BaseUnit): string {
  if (!Number.isSafeInteger(base)) throw new Error("Cantidad no válida.")
  const signo = base < 0 ? "-" : ""
  const v = Math.abs(base)
  if (unit === "u") return `${signo}${v} ud`
  if (v < 1000) return `${signo}${v} ${unit}`
  return `${signo}${decimalEntero(v, 1000)} ${unit === "g" ? "kg" : "l"}`
}
