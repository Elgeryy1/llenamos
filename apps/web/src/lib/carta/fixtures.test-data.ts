import { buildPublicMenu, demoMenu, type OrderLineInput } from "@llenamos/core"
/** Datos de ejemplo de core, solo para pruebas unitarias. Nunca se cargan en pantallas. */
export function exampleMenu() {
  const source = demoMenu()
  return buildPublicMenu({
    ...source,
    restaurantId: "demo-lumbre",
    locationId: "centro",
    restaurantName: "Taberna Lumbre",
    locationName: "Centro",
    brandColor: "#f0a35e",
    timezone: "Europe/Madrid",
    floorModule: true,
  })
}
export const exampleLine: OrderLineInput = {
  kind: "item",
  itemId: "cana",
  variantId: "cana",
  optionIds: [],
  quantity: 2,
  notes: "",
  guest: null,
}
export const exampleAt = Date.UTC(2026, 10, 9, 12, 30)
