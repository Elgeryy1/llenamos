/**
 * Lógica de presentación de inventario y escandallos. Los cálculos de verdad (coste medio,
 * coste de receta, margen, diferencia de recuento) son de `@llenamos/core` y aquí solo se
 * reutilizan: esta carpeta pone textos, filtros y borradores de formulario.
 */
import {
  STOCK_LEVEL_LABEL,
  averageCost,
  costPerDisplayUnit,
  countDifference,
  formatQuantity,
  parseQuantity,
  recipeCost,
  stockLevel,
  type BaseUnit,
  type IngredientCost,
  type IngredientWithId,
  type MenuItem,
  type RecipeCost,
  type RecipeEditable,
  type RecipeLine,
  type RecipeWithId,
  type StockAlert,
  type StockLevel,
  type StockMovement,
  type UnitCost,
  type Variant,
} from "@llenamos/core"

export type ConId<T> = T & { id: string }
export type PlatoDoc = ConId<MenuItem>

/* Dinero y porcentajes ---------------------------------------------------------------------- */

export function euros(cents: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(cents / 100)
}

/** 6525 puntos básicos se escriben «65,3 %». Sin dato, una raya. */
export function porcentaje(bp: number | null): string {
  if (bp === null) return "—"
  const decimas = Math.round(bp / 10)
  const texto = `${Math.trunc(decimas / 10)},${Math.abs(decimas % 10)}`
  return `${decimas < 0 && Math.trunc(decimas / 10) === 0 ? "-" : ""}${texto} %`
}

/** Importe escrito por una persona («1,25», «3») a céntimos exactos, o null si no es válido. */
export function leerEuros(texto: string): number | null {
  const m = /^\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*(?:€|eur|euros)?\s*$/i.exec(texto)
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0")
}

/* Cantidades -------------------------------------------------------------------------------- */

export function textoCantidad(cantidad: number, unidad: BaseUnit): string {
  return formatQuantity(cantidad, unidad)
}

/** Ayuda bajo un campo de cantidad: qué unidades se entienden para ese ingrediente. */
export function ayudaCantidad(unidad: BaseUnit): string {
  if (unidad === "g") return "En gramos. También vale 1,5 kg."
  if (unidad === "ml") return "En mililitros. También valen 25 cl o 1,5 l."
  return "En unidades."
}

export type Lectura = { ok: true; valor: number } | { ok: false; error: string }

/** Lee una cantidad entera en la unidad base del ingrediente. */
export function leerCantidad(texto: string, unidad: BaseUnit, opciones: { permitirCero?: boolean } = {}): Lectura {
  if (texto.trim() === "") return { ok: false, error: "Escribe una cantidad." }
  const valor = parseQuantity(texto, unidad)
  if (valor === null) {
    return { ok: false, error: unidad === "u" ? "Escribe un número entero de unidades." : "No se entiende. Escribe una cantidad exacta, por ejemplo 250 o 1,5 kg." }
  }
  if (valor === 0 && !opciones.permitirCero) return { ok: false, error: "La cantidad debe ser mayor que cero." }
  return { ok: true, valor }
}

/* Existencias ------------------------------------------------------------------------------- */

export const NIVEL_TONO: Record<StockLevel, "neutro" | "habitual" | "aviso" | "alergia"> = {
  ok: "habitual",
  low: "aviso",
  out: "alergia",
  negative: "alergia",
}

export function etiquetaNivel(nivel: StockLevel): string {
  return STOCK_LEVEL_LABEL[nivel]
}

export function nivelDe(ingrediente: Pick<IngredientWithId, "quantity" | "minQuantity">): StockLevel {
  return stockLevel(ingrediente.quantity, ingrediente.minQuantity)
}

export interface FiltroExistencias {
  texto: string
  categoria: string
  soloAvisos: boolean
  incluirInactivos: boolean
}

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("es")

/** Ordena primero lo que pide atención (negativo, agotado, bajo) y luego por nombre. */
export function ordenarExistencias<T extends Pick<IngredientWithId, "quantity" | "minQuantity" | "name">>(lista: readonly T[]): T[] {
  const grave: Record<StockLevel, number> = { negative: 0, out: 1, low: 2, ok: 3 }
  return [...lista].sort((a, b) => grave[nivelDe(a)] - grave[nivelDe(b)] || a.name.localeCompare(b.name, "es"))
}

export function filtrarExistencias<T extends IngredientWithId>(lista: readonly T[], f: FiltroExistencias): T[] {
  const q = norm(f.texto.trim())
  return lista.filter((i) => {
    if (!f.incluirInactivos && !i.active) return false
    if (f.categoria && (i.category ?? "") !== f.categoria) return false
    if (f.soloAvisos && nivelDe(i) === "ok") return false
    return q === "" || norm(i.name).includes(q) || norm(i.category ?? "").includes(q)
  })
}

export function categoriasDe(lista: readonly Pick<IngredientWithId, "category">[]): string[] {
  return [...new Set(lista.map((i) => i.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b, "es"))
}

export interface ResumenExistencias {
  total: number
  conAviso: number
  agotados: number
  negativos: number
}

export function resumirExistencias(lista: readonly IngredientWithId[]): ResumenExistencias {
  const activos = lista.filter((i) => i.active)
  const niveles = activos.map(nivelDe)
  return {
    total: activos.length,
    conAviso: niveles.filter((n) => n !== "ok").length,
    agotados: niveles.filter((n) => n === "out").length,
    negativos: niveles.filter((n) => n === "negative").length,
  }
}

/** Avisos vivos (abiertos o reconocidos) por ingrediente. Solo existen con avisos activados. */
export function avisosVivos(avisos: ReadonlyMap<string, StockAlert>): ReadonlyMap<string, StockAlert> {
  return new Map([...avisos].filter(([, a]) => a.status !== "resolved"))
}

/** Valor del almacén (suma de los valores guardados) para quien ve costes. */
export function valorAlmacen(costes: ReadonlyMap<string, IngredientCost>, ingredientes: readonly IngredientWithId[]): number {
  return ingredientes.reduce((suma, i) => suma + (i.active ? (costes.get(i.id)?.valueCents ?? 0) : 0), 0)
}

export function costeMedio(ingrediente: IngredientWithId, coste: IngredientCost | undefined): UnitCost | null {
  if (!coste) return null
  return averageCost({ quantity: ingrediente.quantity, valueCents: coste.valueCents, lastCost: coste.lastCost })
}

/** «0,85 € por kg» para enseñar el coste medio de un ingrediente. */
export function textoCosteUnitario(ingrediente: IngredientWithId, coste: IngredientCost | undefined): string {
  const medio = costeMedio(ingrediente, coste)
  if (!medio) return "Sin coste"
  const { cents, unit } = costPerDisplayUnit(medio, ingrediente.unit)
  return `${euros(cents)} por ${unit}`
}

/* Recuento ---------------------------------------------------------------------------------- */

export interface LineaRecuentoVista {
  ingredientId: string
  contado: number | null
  /** Lo que decía el libro cuando se contó (cantidad actual menos lo movido desde entonces). */
  esperado: number | null
  /** Contado menos esperado; null si no se ha contado. */
  diferencia: number | null
  /** Movimiento neto desde que se contó (ventas, recepciones…). */
  movido: number
}

/** Vista previa de la reconciliación con la misma función del servidor (`countDifference`). */
export function reconciliar(
  linea: { ingredientId: string; countedQuantity: number | null; countedAt: number | null },
  cantidadActual: number,
  movimientos: readonly Pick<StockMovement, "ingredientId" | "quantity" | "at">[],
): LineaRecuentoVista {
  if (linea.countedQuantity === null || linea.countedAt === null) {
    return { ingredientId: linea.ingredientId, contado: null, esperado: null, diferencia: null, movido: 0 }
  }
  const countedAt = linea.countedAt
  const movido = movimientos.filter((m) => m.ingredientId === linea.ingredientId && m.at > countedAt).reduce((s, m) => s + m.quantity, 0)
  const diferencia = countDifference({ currentQuantity: cantidadActual, movedSinceCount: movido, counted: linea.countedQuantity })
  return { ingredientId: linea.ingredientId, contado: linea.countedQuantity, esperado: linea.countedQuantity - diferencia, diferencia, movido }
}

/* Platos y recetas -------------------------------------------------------------------------- */

export interface FilaPlato {
  key: string
  item: PlatoDoc
  variant: Variant | null
  etiqueta: string
  /** Precio de carta con IVA de esta fila. */
  priceCents: number
  /** Receta que se aplicaría a este plato (la suya o, en una variante, la común). */
  receta: RecipeWithId | null
  /** true si la variante no tiene receta propia y usa la común. */
  heredada: boolean
}

export function claveFila(itemId: string, variantId: string | null): string {
  return `${itemId}:${variantId ?? "-"}`
}

/** Una fila por plato activo, o por variante cuando el plato tiene variantes. */
export function filasPlatos(platos: readonly PlatoDoc[], recetas: readonly RecipeWithId[]): FilaPlato[] {
  const filas: FilaPlato[] = []
  for (const item of [...platos].filter((p) => p.active).sort((a, b) => a.sortOrder - b.sortOrder || a.name.es.localeCompare(b.name.es, "es"))) {
    const delPlato = recetas.filter((r) => r.itemId === item.id)
    const comun = delPlato.find((r) => r.variantId === null) ?? null
    if (item.variants.length === 0) {
      filas.push({ key: claveFila(item.id, null), item, variant: null, etiqueta: item.name.es, priceCents: item.priceCents, receta: comun, heredada: false })
      continue
    }
    for (const v of item.variants) {
      const propia = delPlato.find((r) => r.variantId === v.id) ?? null
      filas.push({
        key: claveFila(item.id, v.id), item, variant: v, etiqueta: `${item.name.es}, ${v.name.es}`, priceCents: v.priceCents,
        receta: propia ?? comun, heredada: propia === null && comun !== null,
      })
    }
  }
  return filas
}

/** Texto corto: «Sin receta», «Receta común», «Versión 3». */
export function estadoReceta(fila: FilaPlato): string {
  if (!fila.receta) return "Sin receta"
  if (fila.heredada) return "Usa la receta común"
  return fila.receta.active ? `Versión ${fila.receta.version}` : "Receta apagada"
}

export interface LineaBorrador {
  ingredientId: string
  /** Cantidad neta por ración, escrita en la unidad del ingrediente. */
  cantidad: string
  /** Rendimiento en porcentaje («85» o «92,5»). */
  rendimiento: string
}

export interface RecetaBorrador {
  name: string
  lines: LineaBorrador[]
  options: Record<string, LineaBorrador[]>
  /** Coste manual por ración en euros, o vacío. */
  manual: string
  active: boolean
}

const aTexto = (n: number) => String(n).replace(".", ",")

function borradorDeLinea(l: RecipeLine, unidad: (id: string) => BaseUnit | undefined): LineaBorrador {
  const u = unidad(l.ingredientId)
  return {
    ingredientId: l.ingredientId,
    cantidad: u === "u" || u === undefined ? String(l.quantity) : l.quantity % 1000 === 0 ? `${l.quantity / 1000} ${u === "g" ? "kg" : "l"}` : String(l.quantity),
    rendimiento: aTexto(l.yieldBp / 100),
  }
}

export function borradorDeReceta(receta: RecipeWithId | null, nombre: string, unidad: (id: string) => BaseUnit | undefined): RecetaBorrador {
  if (!receta) return { name: nombre, lines: [], options: {}, manual: "", active: true }
  return {
    name: receta.name,
    lines: receta.lines.map((l) => borradorDeLinea(l, unidad)),
    options: Object.fromEntries(Object.entries(receta.optionLines).map(([k, ls]) => [k, ls.map((l) => borradorDeLinea(l, unidad))])),
    manual: receta.manualCostCents === null ? "" : (receta.manualCostCents / 100).toFixed(2).replace(".", ","),
    active: receta.active,
  }
}

export function leerRendimiento(texto: string): number | null {
  const m = /^\s*(\d{1,3})(?:[.,](\d{1,2}))?\s*%?\s*$/.exec(texto)
  if (!m) return null
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0")
  return bp >= 1 && bp <= 10000 ? bp : null
}

export type ResultadoBorrador = { ok: true; receta: RecipeEditable } | { ok: false; errores: string[] }

/** Convierte el formulario en la entrada de `guardarReceta`. Los errores van en castellano. */
export function recetaDeBorrador(
  b: RecetaBorrador,
  destino: { itemId: string; variantId: string | null },
  ingredientes: ReadonlyMap<string, Pick<IngredientWithId, "unit" | "name">>,
): ResultadoBorrador {
  const errores: string[] = []
  const convertir = (ls: readonly LineaBorrador[], donde: string): RecipeLine[] => {
    const salida: RecipeLine[] = []
    for (const l of ls) {
      const ing = ingredientes.get(l.ingredientId)
      if (!l.ingredientId || !ing) { errores.push(`${donde}: elige el ingrediente de cada línea.`); continue }
      const q = leerCantidad(l.cantidad, ing.unit)
      if (!q.ok) { errores.push(`${donde}, ${ing.name}: ${q.error}`); continue }
      const y = leerRendimiento(l.rendimiento)
      if (y === null) { errores.push(`${donde}, ${ing.name}: el rendimiento va de 1 a 100 por ciento.`); continue }
      salida.push({ ingredientId: l.ingredientId, quantity: q.valor, yieldBp: y })
    }
    return salida
  }
  const lines = convertir(b.lines, "Ingredientes")
  const optionLines: Record<string, RecipeLine[]> = {}
  for (const [id, ls] of Object.entries(b.options)) {
    const convertidas = convertir(ls, "Extra")
    if (convertidas.length > 0) optionLines[id] = convertidas
  }
  const ids = lines.map((l) => l.ingredientId)
  if (new Set(ids).size !== ids.length) errores.push("Hay ingredientes repetidos en la receta.")
  let manualCostCents: number | null = null
  if (b.manual.trim() !== "") {
    manualCostCents = leerEuros(b.manual)
    if (manualCostCents === null) errores.push("El coste manual no es un importe válido.")
    else if (lines.length > 0) errores.push("Usa ingredientes o un coste manual, no los dos.")
  }
  if (b.name.trim() === "") errores.push("Escribe el nombre de la receta.")
  if (errores.length > 0) return { ok: false, errores }
  return { ok: true, receta: { name: b.name.trim(), itemId: destino.itemId, variantId: destino.variantId, lines, optionLines, manualCostCents, active: b.active } }
}

/** Coste teórico de una ración con los costes medios de hoy (misma función que el servidor). */
export function costeDeReceta(
  receta: Pick<RecipeEditable, "lines" | "optionLines" | "manualCostCents">,
  ingredientes: readonly IngredientWithId[],
  costes: ReadonlyMap<string, IngredientCost>,
  opciones: readonly string[] = [],
): RecipeCost {
  const porId = new Map(ingredientes.map((i) => [i.id, i]))
  return recipeCost(receta, (id) => {
    const ing = porId.get(id)
    return ing ? costeMedio(ing, costes.get(id)) : null
  }, opciones)
}

/** Opciones (extras) de la carta con su grupo, para ligarles ingredientes. */
export function opcionesDelPlato(item: Pick<MenuItem, "modifierGroups">): { id: string; nombre: string; grupo: string }[] {
  return item.modifierGroups.flatMap((g) => g.options.map((o) => ({ id: o.id, nombre: o.name.es, grupo: g.name.es })))
}

/** Cambios entre dos versiones: ingredientes añadidos, quitados o con otra cantidad. */
export function diferenciasVersion(
  anterior: Pick<RecipeEditable, "lines" | "manualCostCents">,
  nueva: Pick<RecipeEditable, "lines" | "manualCostCents">,
  nombre: (id: string) => string,
): string[] {
  const a = new Map(anterior.lines.map((l) => [l.ingredientId, l]))
  const n = new Map(nueva.lines.map((l) => [l.ingredientId, l]))
  const salida: string[] = []
  for (const [id, l] of n) {
    const antes = a.get(id)
    if (!antes) salida.push(`Añade ${nombre(id)}`)
    else if (antes.quantity !== l.quantity || antes.yieldBp !== l.yieldBp) salida.push(`Cambia ${nombre(id)}`)
  }
  for (const id of a.keys()) if (!n.has(id)) salida.push(`Quita ${nombre(id)}`)
  if (anterior.manualCostCents !== nueva.manualCostCents) salida.push("Cambia el coste manual")
  return salida
}
