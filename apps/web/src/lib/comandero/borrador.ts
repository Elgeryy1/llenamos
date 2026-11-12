"use client"

import { useState } from "react"
import { z } from "zod"
import { FireModeSchema, OrderLinesInputSchema } from "@llenamos/core"

const envioSchema = z.object({
  requestId: z.string(), lines: OrderLinesInputSchema, total: z.number().int(),
  fire: FireModeSchema, note: z.string(), destination: z.string().optional(), prices: z.string().optional(),
})
export const borradorSchema = z.object({
  lines: OrderLinesInputSchema.or(z.tuple([])), note: z.string(), fire: FireModeSchema,
  destination: z.string().optional(), reviewedTotal: z.number().nullable(), reviewedPrices: z.string().optional(),
  pending: envioSchema.nullable(),
})
export type Envio = z.infer<typeof envioSchema>
export type Borrador = z.infer<typeof borradorSchema>

/** Escritura síncrona antes del envío: recargar nunca pierde su clave. */
export function useBorrador(key?: string, destination?: string) {
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Borrador>(() => {
    if (key && typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem(key)
        if (saved) return borradorSchema.parse(JSON.parse(saved))
      } catch { /* Un documento incompatible no se utiliza como pedido. */ }
    }
    return { lines: [], note: "", fire: "auto", destination, reviewedTotal: null, pending: null }
  })
  function update(value: Borrador) {
    if (key) {
      try { localStorage.setItem(key, JSON.stringify(value)); setError(null) }
      catch { setError("No se puede guardar el borrador en este navegador. Activa el almacenamiento para enviar sin perder su clave."); setDraft(value); return false }
    }
    setDraft(value)
    return true
  }
  return { draft, update, error }
}

export function definitiveRejection(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code).replace("functions/", "") : ""
  return ["failed-precondition", "permission-denied", "invalid-argument", "unauthenticated", "review"].includes(code)
}
