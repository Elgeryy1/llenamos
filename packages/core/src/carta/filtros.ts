import type { Language } from "../model"
import { localize } from "./textos"
import type { Allergen } from "./modelo"
import type { PublicMenu, PublicMenuItem } from "./publica"

const normal = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .trim()
/** Se incluyen trazas y todos los extras, para no sugerir combinaciones incompatibles. */
export function matchesAllergens(item: PublicMenuItem, excluded: readonly Allergen[]): boolean {
  if (!excluded.length) return true
  if (!item.allergensReviewed) return false
  const declared = [
    ...item.allergens,
    ...item.traces,
    ...item.modifierGroups.flatMap((g) => g.options.flatMap((o) => o.allergens)),
  ]
  return !declared.some((a) => excluded.includes(a))
}
export function filterPublicMenu(
  menu: PublicMenu,
  language: Language,
  search = "",
  categoryId = "",
  excluded: readonly Allergen[] = [],
) {
  const query = normal(search)
  const match = (value: { name: PublicMenuItem["name"]; description: PublicMenuItem["description"] }) =>
    !query ||
    normal(`${localize(value.name, language)} ${localize(value.description, language)}`).includes(query)
  const categories = menu.categories.filter((c) => !categoryId || c.id === categoryId)
  const visible = menu.items.filter((i) => menu.categories.some((c) => c.id === i.categoryId))
  const candidates = visible.filter((i) => (!categoryId || i.categoryId === categoryId) && match(i))
  const items = candidates.filter((i) => matchesAllergens(i, excluded))
  // Un menú también incluye pan, bebida u otros elementos sin ficha propia. No se presume su composición.
  const dailyMenus = categoryId || excluded.length ? [] : menu.dailyMenus.filter(match)
  return {
    categories,
    items,
    dailyMenus,
    hidden: candidates.length - items.length,
    incomplete: visible.filter((i) => !i.allergensReviewed).length,
    total: items.length + dailyMenus.length,
  }
}
