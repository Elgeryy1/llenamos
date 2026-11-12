/** Búsqueda de clientes por nombre (sin acentos) o por teléfono (con o sin prefijo y espacios). */
import { tryNormalizePhone, type Customer } from "@llenamos/core"
import { fold } from "./estados"

export function matchesCustomer(c: Pick<Customer, "name" | "phone" | "email">, search: string): boolean {
  const q = fold(search)
  if (q === "") return true
  if (fold(c.name).includes(q)) return true
  if (c.email && c.email.includes(q)) return true
  const digits = search.replace(/\D/g, "")
  if (digits.length >= 3 && c.phone.replace(/\D/g, "").includes(digits)) return true
  const e164 = tryNormalizePhone(search)
  return e164 !== null && e164 === c.phone
}
