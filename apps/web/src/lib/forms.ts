import type { ZodError } from "zod"

/** Primer error de cada campo de un formulario, para enseñarlo debajo del campo. */
export function fieldErrors<K extends string>(error: ZodError, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {}
  for (const issue of error.issues) {
    const key = issue.path[0]
    if (typeof key === "string" && (keys as readonly string[]).includes(key) && !out[key as K]) {
      out[key as K] = issue.message
    }
  }
  return out
}

/**
 * Contraseña temporal fácil de dictar: sin letras que se confunden (l, 1, O, 0).
 * Se genera en el navegador con crypto, nunca con Math.random.
 */
export function temporaryPassword(length = 12): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
}
