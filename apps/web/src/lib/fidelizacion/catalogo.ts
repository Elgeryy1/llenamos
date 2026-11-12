"use client"

import { MenuCategorySchema, MenuItemSchema } from "@llenamos/core"
import { useEntries } from "@/lib/carta/hooks"

export type OpcionCatalogo = { id: string; name: string }
export type Catalogo = { items: OpcionCatalogo[]; categories: OpcionCatalogo[]; locations: OpcionCatalogo[] }
export const catalogoFixture: Catalogo = { items: [{ id: "cafe", name: "Café de la casa" }, { id: "croquetas", name: "Croquetas de setas" }], categories: [{ id: "postres", name: "Postres" }, { id: "entrantes", name: "Para compartir" }], locations: [{ id: "centro", name: "Centro" }] }
export function useCatalogoFidelizacion(restaurantId: string, locationId: string | null) {
  const base = locationId ? `restaurants/${restaurantId}/locations/${locationId}` : null
  const items = useEntries(base, "menuItems", MenuItemSchema)
  const categories = useEntries(base, "menuCategories", MenuCategorySchema)
  return { items, categories }
}
