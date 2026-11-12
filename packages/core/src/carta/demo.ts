/**
 * Carta de demostración de Taberna Lumbre (inventada). La usan las pruebas de core, el seed
 * (`pnpm seed`) y los datos de prueba de la web, para que todos trabajen con la misma carta.
 * Precios con IVA incluido, en céntimos.
 */
import type { DailyMenu, MenuCategory, MenuItem, Station } from "./modelo"
import { defaultFloorSettings, type FloorSettings } from "../sala/modelo"

export interface DemoMenu {
  categories: Record<string, MenuCategory>
  items: Record<string, MenuItem>
  dailyMenus: Record<string, DailyMenu>
  stations: Record<string, Station>
  settings: FloorSettings
}

const t = (es: string, ca: string, en: string) => ({ es, ca, en })
const vacio = { es: "", ca: "", en: "" }

type Base = Omit<MenuItem, "variants" | "modifierGroups" | "allergens" | "traces" | "dietary" | "description" | "photoPath" | "stationId" | "prepMinutes" | "taxRate" | "selfOrder" | "takeaway" | "active" | "soldOut" | "version">

function plato(base: Base, resto: Partial<MenuItem> = {}): MenuItem {
  return {
    description: vacio,
    variants: [],
    modifierGroups: [],
    allergens: [],
    traces: [],
    dietary: [],
    photoPath: null,
    stationId: null,
    prepMinutes: null,
    taxRate: 10,
    selfOrder: true,
    takeaway: true,
    active: true,
    soldOut: false,
    version: 1,
    ...base,
    ...resto,
  }
}

/** Una copia nueva cada vez: las pruebas pueden cambiarla sin afectar a las demás. */
export function demoMenu(): DemoMenu {
  const categories: Record<string, MenuCategory> = {
    bebidas: { name: t("Bebidas", "Begudes", "Drinks"), description: vacio, sortOrder: 10, active: true },
    compartir: { name: t("Para compartir", "Per compartir", "To share"), description: vacio, sortOrder: 20, active: true },
    principales: { name: t("Principales", "Principals", "Mains"), description: vacio, sortOrder: 30, active: true },
    postres: { name: t("Postres", "Postres", "Desserts"), description: vacio, sortOrder: 40, active: true },
    // Platos que solo salen en el menú del día.
    menu: { name: t("Solo en el menú", "Només al menú", "Set menu only"), description: vacio, sortOrder: 90, active: false },
  }

  const items: Record<string, MenuItem> = {
    cana: plato(
      { categoryId: "bebidas", name: t("Cerveza", "Cervesa", "Beer"), sortOrder: 10, priceCents: 0, course: "drinks" },
      {
        variants: [
          { id: "cana", name: t("Caña", "Canya", "Small"), priceCents: 250 },
          { id: "doble", name: t("Doble", "Doble", "Medium"), priceCents: 380 },
          { id: "jarra", name: t("Jarra", "Gerra", "Pint"), priceCents: 550 },
        ],
        allergens: ["gluten"],
        stationId: "barra",
        taxRate: 21,
      },
    ),
    vino: plato(
      { categoryId: "bebidas", name: t("Vino tinto de la casa", "Vi negre de la casa", "House red wine"), sortOrder: 20, priceCents: 0, course: "drinks" },
      {
        variants: [
          { id: "copa", name: t("Copa", "Copa", "Glass"), priceCents: 350 },
          { id: "botella", name: t("Botella", "Ampolla", "Bottle"), priceCents: 1800 },
        ],
        allergens: ["sulphites"],
        stationId: "barra",
        taxRate: 21,
        // Alcohol: se pide al camarero.
        selfOrder: false,
      },
    ),
    agua: plato(
      { categoryId: "bebidas", name: t("Agua mineral", "Aigua mineral", "Mineral water"), sortOrder: 30, priceCents: 200, course: "drinks" },
      { stationId: "barra" },
    ),
    bravas: plato(
      { categoryId: "compartir", name: t("Patatas bravas", "Patates braves", "Patatas bravas"), sortOrder: 10, priceCents: 650, course: "first" },
      {
        description: t("Con alioli y salsa brava de la casa.", "Amb allioli i salsa brava de la casa.", "With aioli and our spicy brava sauce."),
        allergens: ["eggs"],
        dietary: ["vegetarian"],
        stationId: "cocina",
        prepMinutes: 8,
      },
    ),
    croquetas: plato(
      { categoryId: "compartir", name: t("Croquetas de jamón", "Croquetes de pernil", "Ham croquettes"), sortOrder: 20, priceCents: 0, course: "first" },
      {
        variants: [
          { id: "media", name: t("Media", "Mitja", "Half"), priceCents: 600 },
          { id: "racion", name: t("Ración", "Ració", "Full"), priceCents: 1050 },
        ],
        allergens: ["gluten", "milk", "eggs"],
        stationId: "cocina",
      },
    ),
    ensalada: plato(
      { categoryId: "compartir", name: t("Ensalada de tomate y burrata", "Amanida de tomàquet i burrata", "Tomato and burrata salad"), sortOrder: 30, priceCents: 1150, course: "first" },
      { allergens: ["milk"], traces: ["nuts"], dietary: ["vegetarian"], stationId: "cocina", prepMinutes: 6 },
    ),
    entrecot: plato(
      { categoryId: "principales", name: t("Entrecot de ternera", "Entrecot de vedella", "Beef sirloin"), sortOrder: 10, priceCents: 2200, course: "second" },
      {
        modifierGroups: [
          {
            id: "punto",
            name: t("Punto de la carne", "Punt de la carn", "How would you like it"),
            min: 1,
            max: 1,
            options: [
              { id: "poco", name: t("Poco hecho", "Poc fet", "Rare"), priceCents: 0, allergens: [], soldOut: false },
              { id: "punto", name: t("Al punto", "Al punt", "Medium"), priceCents: 0, allergens: [], soldOut: false },
              { id: "hecho", name: t("Hecho", "Fet", "Well done"), priceCents: 0, allergens: [], soldOut: false },
            ],
          },
          {
            id: "salsa",
            name: t("Salsa", "Salsa", "Sauce"),
            min: 0,
            max: 1,
            options: [
              { id: "pimienta", name: t("Pimienta", "Pebre", "Pepper"), priceCents: 150, allergens: ["milk"], soldOut: false },
              { id: "roquefort", name: t("Roquefort", "Rocafort", "Roquefort"), priceCents: 200, allergens: ["milk"], soldOut: false },
            ],
          },
        ],
        stationId: "cocina",
        prepMinutes: 18,
      },
    ),
    lubina: plato(
      { categoryId: "principales", name: t("Lubina a la brasa", "Llobarro a la brasa", "Grilled sea bass"), sortOrder: 20, priceCents: 1950, course: "second" },
      { allergens: ["fish"], stationId: "cocina", prepMinutes: 16 },
    ),
    hamburguesa: plato(
      { categoryId: "principales", name: t("Hamburguesa Lumbre", "Hamburguesa Lumbre", "Lumbre burger"), sortOrder: 30, priceCents: 1400, course: "second" },
      {
        modifierGroups: [
          {
            id: "extras",
            name: t("Añade", "Afegeix", "Add"),
            min: 0,
            max: 2,
            options: [
              { id: "queso", name: t("Queso cheddar", "Formatge cheddar", "Cheddar"), priceCents: 150, allergens: ["milk"], soldOut: false },
              { id: "bacon", name: t("Bacon", "Bacon", "Bacon"), priceCents: 200, allergens: [], soldOut: false },
            ],
          },
        ],
        allergens: ["gluten", "sesame", "mustard"],
        stationId: "cocina",
      },
    ),
    crema: plato(
      { categoryId: "postres", name: t("Crema catalana", "Crema catalana", "Crema catalana"), sortOrder: 10, priceCents: 550, course: "dessert" },
      { allergens: ["milk", "eggs"], stationId: "postres" },
    ),
    tarta: plato(
      { categoryId: "postres", name: t("Tarta de queso", "Pastís de formatge", "Cheesecake"), sortOrder: 20, priceCents: 650, course: "dessert" },
      { allergens: ["milk", "eggs", "gluten"], stationId: "postres", soldOut: true },
    ),
    sopa: plato(
      { categoryId: "menu", name: t("Sopa de galets", "Sopa de galets", "Galets soup"), sortOrder: 10, priceCents: 0, course: "first" },
      { allergens: ["gluten", "celery"], stationId: "cocina", selfOrder: false, takeaway: false },
    ),
    pollo: plato(
      { categoryId: "menu", name: t("Pollo asado", "Pollastre rostit", "Roast chicken"), sortOrder: 20, priceCents: 0, course: "second" },
      { stationId: "cocina", selfOrder: false, takeaway: false },
    ),
  }

  const dailyMenus: Record<string, DailyMenu> = {
    mediodia: {
      name: t("Menú del mediodía", "Menú del migdia", "Lunch set menu"),
      description: vacio,
      includes: t("Pan, bebida y postre", "Pa, beguda i postres", "Bread, drink and dessert"),
      priceCents: 1550,
      days: ["mon", "tue", "wed", "thu", "fri"],
      from: "13:00",
      to: "16:00",
      sections: [
        {
          id: "primeros",
          name: t("Primeros", "Primers", "Starters"),
          course: "first",
          min: 1,
          max: 1,
          choices: [
            { itemId: "sopa", variantId: null, supplementCents: 0 },
            { itemId: "ensalada", variantId: null, supplementCents: 0 },
            { itemId: "croquetas", variantId: "media", supplementCents: 0 },
          ],
        },
        {
          id: "segundos",
          name: t("Segundos", "Segons", "Mains"),
          course: "second",
          min: 1,
          max: 1,
          choices: [
            { itemId: "pollo", variantId: null, supplementCents: 0 },
            { itemId: "lubina", variantId: null, supplementCents: 0 },
            { itemId: "entrecot", variantId: null, supplementCents: 400 },
          ],
        },
        {
          id: "postres",
          name: t("Postres", "Postres", "Desserts"),
          course: "dessert",
          min: 1,
          max: 1,
          choices: [
            { itemId: "crema", variantId: null, supplementCents: 0 },
            { itemId: "tarta", variantId: null, supplementCents: 0 },
          ],
        },
      ],
      sortOrder: 0,
      taxRate: 10,
      selfOrder: true,
      takeaway: false,
      active: true,
      version: 1,
    },
  }

  const stations: Record<string, Station> = {
    cocina: { name: "Cocina", kind: "kitchen", sortOrder: 10, targetMinutes: 15, pickup: true, active: true },
    postres: { name: "Postres", kind: "kitchen", sortOrder: 20, targetMinutes: 6, pickup: true, active: true },
    barra: { name: "Barra", kind: "bar", sortOrder: 30, targetMinutes: 4, pickup: true, active: true },
  }

  const settings: FloorSettings = {
    ...defaultFloorSettings(),
    selfOrder: { enabled: true, requireApproval: true, callWaiter: true, requestBill: true },
    takeaway: { enabled: true, publicOrdering: true, autoAccept: false, stepMinutes: 15, minNoticeMinutes: 30, maxOrdersPerSlot: 4, prepLeadMinutes: 20 },
    defaultStationId: "cocina",
  }

  return { categories, items, dailyMenus, stations, settings }
}
