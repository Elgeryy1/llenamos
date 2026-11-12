"use client"
import {
  DailyMenuSchema,
  FloorSettingsSchema,
  MenuCategorySchema,
  MenuItemSchema,
  PublicMenuSchema,
  StationSchema,
  defaultFloorSettings,
  publicMenuId,
} from "@llenamos/core"
import type { z } from "zod"
import type { Live } from "@/lib/api/live"
import { useDemoDoc, useDemoQuery } from "@/lib/sala/demo"
import { useEffect, useState } from "react"
import { verCartaPublica } from "@/lib/carta/callables"
import { alcanceDe, useDerivado, enVps, useCartaVivaVps } from "@/lib/sala/vivo"

type Id<T> = T & { id: string }
function useCatalogFs(restaurantId: string, locationId: string | null) {
  const base = locationId ? `restaurants/${restaurantId}/locations/${locationId}` : null
  const categories = useEntries(base, "menuCategories", MenuCategorySchema)
  const items = useEntries(base, "menuItems", MenuItemSchema)
  const menus = useEntries(base, "dailyMenus", DailyMenuSchema)
  return { categories, items, menus }
}
function useCatalogVps(restaurantId: string, locationId: string | null) {
  const live = useCartaVivaVps(locationId ? { restaurantId, locationId } : null)
  return { categories: useDerivado(live, v => v.categories as Id<z.output<typeof MenuCategorySchema>>[]), items: useDerivado(live, v => v.items as Id<z.output<typeof MenuItemSchema>>[]), menus: useDerivado(live, v => v.menus as Id<z.output<typeof DailyMenuSchema>>[]) }
}
export const useCatalog = enVps ? useCatalogVps : useCatalogFs
export function useEntries<T extends object>(base: string | null, name: string, schema: z.ZodType<T>) {
  const path = base ? `${base}/${name}` : null
  return useDemoQuery(path, [], (id, data) => ({ id, ...schema.parse(data) }))
}
function useStationsFs(base: string | null) {
  return useEntries(base, "stations", StationSchema)
}
function useStationsVps(base: string | null) {
  const scope = alcanceDe(base)
  return useDerivado(useCartaVivaVps(scope), v => v.stations as Id<z.output<typeof StationSchema>>[])
}
export const useStations = enVps ? useStationsVps : useStationsFs
function useFloorFs(base: string | null) {
  return useDemoDoc(base ? `${base}/settings/floor` : null, (_id, data) => ({
    saved: data !== undefined,
    settings: data === undefined ? defaultFloorSettings() : FloorSettingsSchema.parse(data),
  }))
}
function useFloorVps(base: string | null) {
  return useDerivado(useCartaVivaVps(alcanceDe(base)), v => ({ saved: v.settingsSaved, settings: v.settings }))
}
export const useFloor = enVps ? useFloorVps : useFloorFs
/** Demo: documento `publicMenus/{id}`. VPS: la API devuelve la misma proyección por slug y local. */
function useMenuFs(id: string | null) {
  return useDemoDoc(id ? `publicMenus/${id}` : null, (_id, data) =>
    data === undefined ? null : PublicMenuSchema.parse(data),
  )
}
function useMenuVps(id: string | null, scope?: { slug: string; locationId: string } | null): Live<z.output<typeof PublicMenuSchema> | null> {
  const key = id && scope ? JSON.stringify([scope.slug, scope.locationId]) : null
  const [state, setState] = useState<{ key: string | null; live: Live<z.output<typeof PublicMenuSchema> | null> }>({ key: null, live: { status: "loading" } })
  useEffect(() => {
    if (!key || !scope) return
    let active = true
    const read = () => verCartaPublica(scope.slug, scope.locationId)
      .then(data => active && setState({ key, live: { status: "ready", data: data } }))
      .catch(error => active && setState({ key, live: { status: "error", error } }))
    void read()
    const timer = setInterval(() => { if (!document.hidden) void read() }, 60_000)
    return () => { active = false; clearInterval(timer) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return key && state.key === key ? state.live : { status: "loading" }
}
export const useMenu: (id: string | null, scope?: { slug: string; locationId: string } | null) => Live<z.output<typeof PublicMenuSchema> | null> = enVps ? useMenuVps : useMenuFs
export { publicMenuId }
