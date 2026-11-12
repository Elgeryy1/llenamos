"use client"

import { CampaignSchema, MarketingSettingsSchema, SegmentSchema, type Campaign, type Segment } from "@llenamos/core"
import { z } from "zod"
import { useLiveQuery as useLiveApi } from "@/lib/api/live"
import { useLiveDoc, useLiveQuery } from "@/lib/fase4/demo"
import { modoVps, useEntrada } from "@/lib/fase4/vivo"

export type Campana = Campaign & { id: string }
export type Segmento = Segment & { id: string }

const CampanasVivoSchema = z.array(CampaignSchema.extend({ id: z.string() }))
const SegmentosVivoSchema = z.array(SegmentSchema.extend({ id: z.string() }))
const AjustesVivoSchema = MarketingSettingsSchema.nullable()

/** Con `NEXT_PUBLIC_DATA_BACKEND=postgres` salen de las lecturas `campanas.*` de la API y Firestore no se escucha. */
export function useCampanas(restaurantId: string) {
  const vps = modoVps()
  const path = `restaurants/${restaurantId}/campaigns`
  const demo = useLiveQuery(
    vps ? null : path,
    (db, fs) => fs.query(fs.collection(db, path)),
    (id, data) => ({ ...CampaignSchema.parse(data), id }),
  )
  const api = useLiveApi("campanas.campanas", useEntrada(vps, { restaurantId }), CampanasVivoSchema)
  return vps ? api : demo
}
export function useSegmentos(restaurantId: string) {
  const vps = modoVps()
  const path = `restaurants/${restaurantId}/segments`
  const demo = useLiveQuery(
    vps ? null : path,
    (db, fs) => fs.query(fs.collection(db, path)),
    (id, data) => ({ ...SegmentSchema.parse(data), id }),
  )
  const api = useLiveApi("campanas.segmentos", useEntrada(vps, { restaurantId }), SegmentosVivoSchema)
  return vps ? api : demo
}
// Los ajustes guardados incluyen autor y fechas; la entrada callable sigue siendo estricta.
export function leerAjustesMarketing(data: Record<string, unknown>) {
  return MarketingSettingsSchema.parse(Object.fromEntries(Object.keys(MarketingSettingsSchema.shape).map((key) => [key, data[key]])))
}
export function useAjustesMarketing(restaurantId: string) {
  const vps = modoVps()
  const demo = useLiveDoc(vps ? null : `restaurants/${restaurantId}/settings/marketing`, (_id, data) => (data ? leerAjustesMarketing(data) : null))
  const api = useLiveApi("campanas.ajustes", useEntrada(vps, { restaurantId }), AjustesVivoSchema)
  return vps ? api : demo
}
