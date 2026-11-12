"use client"

import {
  DailyMenuSchema,
  FloorSettingsSchema, defaultFloorSettings,
  FloorTaskSchema,
  MenuCategorySchema,
  MenuItemSchema,
  OrderLineSchema,
  OrderSchema,
  TableSessionSchema,
  TakeawaySchema,
  type DailyMenu,
  type MenuCategory,
  type MenuItem,
} from "@llenamos/core"
import type { z } from "zod"
import type { Live } from "@/lib/api/live"
import { useDemoDoc, useDemoQuery } from "@/lib/sala/demo"
import { useDerivado, enVps, useCartaVivaVps, useServicioCompleto, useServicioVivo } from "@/lib/sala/vivo"

export type Alcance = { restaurantId: string; locationId: string }
export function rutaLocal(s: Alcance) {
  return `restaurants/${s.restaurantId}/locations/${s.locationId}`
}

function lector<T extends object>(schema: z.ZodType<T>) {
  return (id: string, data: unknown): T & { id: string } => ({
    ...schema.parse(data),
    id,
  })
}
const leerMesa = lector(TableSessionSchema)
const leerPlato = lector(MenuItemSchema)
const leerCategoria = lector(MenuCategorySchema)
const leerMenu = lector(DailyMenuSchema)
const leerTarea = lector(FloorTaskSchema)
const leerPedido = lector(OrderSchema)
const leerLinea = lector(OrderLineSchema)
const leerRecogida = lector(TakeawaySchema)

function useMesasFs(s: Alcance) {
  const path = `${rutaLocal(s)}/tableSessions`
  return useDemoQuery(path, [], leerMesa)
}

export type Carta = {
  items: (MenuItem & { id: string })[]
  categories: (MenuCategory & { id: string })[]
  menus: (DailyMenu & { id: string })[]
}
function useCartaFs(s: Alcance): Live<Carta> {
  const base = rutaLocal(s)
  const items = useDemoQuery(`${base}/menuItems`, [], leerPlato)
  const categories = useDemoQuery(`${base}/menuCategories`, [], leerCategoria)
  const menus = useDemoQuery(`${base}/dailyMenus`, [], leerMenu)
  if (items.status === "error") return items
  if (categories.status === "error") return categories
  if (menus.status === "error") return menus
  if (
    items.status !== "ready" ||
    categories.status !== "ready" ||
    menus.status !== "ready"
  )
    return { status: "loading" } as const
  return {
    status: "ready",
    data: { items: items.data, categories: categories.data, menus: menus.data },
  } as const
}

function useTareasFs(s: Alcance) {
  const path = `${rutaLocal(s)}/floorTasks`
  return useDemoQuery(path, [["status", "in", ["open", "claimed"]]], leerTarea)
}

function useDestinoFs(
  s: Alcance,
  kind: "sessionId" | "takeawayId",
  id: string,
) {
  const base = rutaLocal(s)
  const lines = useDemoQuery(`${base}/orderLines`, [[kind, "==", id]], leerLinea)
  const orders = useDemoQuery(`${base}/orders`, [[kind, "==", id]], leerPedido)
  return { lines, orders }
}

function useRecogidasFs(s: Alcance) {
  const path = `${rutaLocal(s)}/takeaways`
  return useDemoQuery(path, [], leerRecogida)
}

function useServicioFs(s: Alcance) {
  const path = `${rutaLocal(s)}/orderLines`
  return useDemoQuery(path, [], leerLinea)
}
function useComandasFs(s: Alcance) {
  const path = `${rutaLocal(s)}/orders`
  return useDemoQuery(path, [], leerPedido)
}
function useAjustesSalaFs(s: Alcance) {
  return useDemoDoc(`${rutaLocal(s)}/settings/floor`, (_id, data) => data ? FloorSettingsSchema.parse(data) : defaultFloorSettings())
}

/* En modo VPS la API entrega el servicio vivo acotado (`salaServicio`): mesas abiertas, sus líneas,
 * tareas activas y recogidas vigentes, más lo cerrado en las últimas horas (`salaHistorial`). */
function useMesasVps(s: Alcance) { return useDerivado(useServicioCompleto(s), v => v.sessions) }
function useTareasVps(s: Alcance) { return useDerivado(useServicioVivo(s), v => v.tasks) }
function useRecogidasVps(s: Alcance) { return useDerivado(useServicioCompleto(s), v => v.takeaways) }
function useServicioVps(s: Alcance) { return useDerivado(useServicioCompleto(s), v => v.lines) }
function useComandasVps(s: Alcance) { return useDerivado(useServicioCompleto(s), v => v.orders) }
function useAjustesSalaVps(s: Alcance) { return useDerivado(useCartaVivaVps(s), v => v.settings) }
function useCartaVps(s: Alcance): Live<Carta> { return useDerivado(useCartaVivaVps(s), v => ({ items: v.items, categories: v.categories, menus: v.menus })) }
function useDestinoVps(s: Alcance, kind: "sessionId" | "takeawayId", id: string) {
  const live = useServicioCompleto(s)
  return {
    lines: useDerivado(live, v => v.lines.filter(l => l[kind] === id)),
    orders: useDerivado(live, v => v.orders.filter(o => o[kind] === id)),
  }
}
export const useMesas = enVps ? useMesasVps : useMesasFs
export const useTareas = enVps ? useTareasVps : useTareasFs
export const useRecogidas = enVps ? useRecogidasVps : useRecogidasFs
export const useServicio = enVps ? useServicioVps : useServicioFs
export const useComandas = enVps ? useComandasVps : useComandasFs
export const useAjustesSala = enVps ? useAjustesSalaVps : useAjustesSalaFs
export const useCarta = enVps ? useCartaVps : useCartaFs
export const useDestino = enVps ? useDestinoVps : useDestinoFs
