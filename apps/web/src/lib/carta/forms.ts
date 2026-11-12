import { MenuItemEditableSchema, DailyMenuEditableSchema, type MenuText } from "@llenamos/core"
export const text = (es = ""): MenuText => ({ es, ca: "", en: "" })
// Los borradores pueden tener nombres vacíos hasta que se validan al guardar.
export const categoryDraft = () => ({ name: text(), description: text(), sortOrder: 0, active: true })
export const itemDraft = (categoryId = "") => ({
  categoryId,
  name: text(),
  description: text(),
  sortOrder: 0,
  priceCents: 0,
  variants: [],
  modifierGroups: [],
  allergens: [],
  traces: [],
  dietary: [],
  photoPath: null,
  course: "first" as const,
  stationId: null,
  prepMinutes: null,
  taxRate: 10 as const,
  selfOrder: true,
  takeaway: false,
  active: true,
})
export const menuDraft = () => ({
  name: text(),
  description: text(),
  includes: text(),
  priceCents: 0,
  days: ["mon", "tue", "wed", "thu", "fri"] as ("mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun")[],
  from: "13:00",
  to: "16:00",
  sections: [],
  sortOrder: 0,
  taxRate: 10 as const,
  selfOrder: true,
  takeaway: false,
  active: true,
})
export const editableItem = (data: unknown) => MenuItemEditableSchema.parse(data)
export const editableMenu = (data: unknown) => DailyMenuEditableSchema.parse(data)
export function centsFromEuros(value: string): number {
  if (!/^\d+(?:[.,]\d{0,2})?$/.test(value)) throw new Error("Escribe un precio con un máximo de dos decimales.")
  const [whole, fraction = ""] = value.replace(",", ".").split(".")
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  if (!Number.isSafeInteger(result) || result > 10_000_000) throw new Error("El precio es demasiado alto.")
  return result
}
export const euros = (cents: number, language = "es") =>
  new Intl.NumberFormat(language, { style: "currency", currency: "EUR" }).format(cents / 100)
