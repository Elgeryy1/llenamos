"use client"

import { z } from "zod"
import { LoyaltyRewardSchema, LoyaltySettingsSchema, PromotionSchema, RepiteSettingsSchema } from "@llenamos/core"
import { useLiveQuery as useLiveApi } from "@/lib/api/live"
import { useLiveDoc, useLiveQuery } from "@/lib/fase4/demo"
import { modoVps, useEntrada } from "@/lib/fase4/vivo"

/** Lecturas de la API para cada ruta de la demo (`apps/api/src/modules/fidelizacion/live.ts`). */
const AJUSTES_VIVOS: Record<string, string> = { "settings/loyalty": "fidelizacion.ajustes", "settings/repite": "fidelizacion.repite" }
const COLECCIONES_VIVAS: Record<string, string> = { loyaltyRewards: "fidelizacion.premios", promotions: "fidelizacion.promociones" }
const conId = <S extends z.ZodType>(schema: S) => z.array(z.intersection(z.object({ id: z.string() }), schema as z.ZodType<object>))

export function useDocumento<S extends z.ZodType>(restaurantId: string, nombre: string, schema: S, activo = true) {
  const vps = modoVps()
  const demo = useLiveDoc(!vps && activo ? `restaurants/${restaurantId}/${nombre}` : null, (_id, data): z.output<S> | null => {
    if (data === undefined) return null
    // Firestore añade metadatos que los esquemas estrictos de ajustes no admiten.
    const campos = Object.fromEntries(Object.entries(data).filter(([key]) => !["createdAt", "updatedAt", "updatedBy", "changeId"].includes(key)))
    return schema.parse(campos)
  })
  const lectura = AJUSTES_VIVOS[nombre]
  const api = useLiveApi(lectura ?? "fidelizacion.desconocida", useEntrada(vps && activo && lectura !== undefined, { restaurantId }), schema.nullable())
  if (vps && lectura === undefined) return { status: "error", error: new Error(`Ajuste sin lectura en el servidor: ${nombre}`) } as typeof demo
  return (vps ? api : demo) as typeof demo
}
export function useColeccion<S extends z.ZodType>(restaurantId: string, nombre: string, schema: S, activo = true) {
  const vps = modoVps()
  const path = `restaurants/${restaurantId}/${nombre}`
  const demo = useLiveQuery(!vps && activo ? `fidelizacion:${path}` : null, (db, fs) => fs.query(fs.collection(db, path)), (id, data) => ({ id, ...(schema.parse(data) as object) }) as { id: string } & z.output<S>)
  const lectura = COLECCIONES_VIVAS[nombre]
  const api = useLiveApi(lectura ?? "fidelizacion.desconocida", useEntrada(vps && activo && lectura !== undefined, { restaurantId }), conId(schema))
  if (vps && lectura === undefined) return { status: "error", error: new Error(`Colección sin lectura en el servidor: ${nombre}`) } as typeof demo
  return (vps ? api : demo) as typeof demo
}
export const esquemas = { LoyaltyRewardSchema, LoyaltySettingsSchema, PromotionSchema, RepiteSettingsSchema }
