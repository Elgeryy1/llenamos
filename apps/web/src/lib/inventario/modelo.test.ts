import type { IngredientWithId, RecipeWithId } from "@llenamos/core"
import { describe, expect, it } from "vitest"
import {
  borradorDeReceta, costeDeReceta, diferenciasVersion, filasPlatos, filtrarExistencias, leerCantidad, leerEuros, leerRendimiento,
  nivelDe, ordenarExistencias, porcentaje, reconciliar, recetaDeBorrador, resumirExistencias, textoCosteUnitario, type PlatoDoc,
} from "./modelo"

const ing = (id: string, name: string, quantity: number, minQuantity: number, extra: Partial<IngredientWithId> = {}): IngredientWithId => ({
  id, name, unit: "g", category: "Despensa", minQuantity, targetQuantity: null, active: true, quantity, revision: 1, ...extra,
})

describe("porcentajes y dinero", () => {
  it("enseña los puntos básicos con una decimal", () => {
    expect(porcentaje(6525)).toBe("65,3 %")
    expect(porcentaje(7000)).toBe("70,0 %")
    expect(porcentaje(-50)).toBe("-0,5 %")
    expect(porcentaje(null)).toBe("—")
  })
  it("lee euros sin redondear", () => {
    expect(leerEuros("12,5")).toBe(1250)
    expect(leerEuros("3")).toBe(300)
    expect(leerEuros("0,07 €")).toBe(7)
    expect(leerEuros("1,234")).toBeNull()
    expect(leerEuros("abc")).toBeNull()
  })
})

describe("cantidades", () => {
  it("convierte a la unidad base y rechaza lo que no sale entero", () => {
    expect(leerCantidad("1,5 kg", "g")).toEqual({ ok: true, valor: 1500 })
    expect(leerCantidad("25 cl", "ml")).toEqual({ ok: true, valor: 250 })
    expect(leerCantidad("0,5 g", "g").ok).toBe(false)
    expect(leerCantidad("2 l", "g").ok).toBe(false)
    expect(leerCantidad("", "g").ok).toBe(false)
    expect(leerCantidad("0", "g").ok).toBe(false)
    expect(leerCantidad("0", "g", { permitirCero: true })).toEqual({ ok: true, valor: 0 })
  })
  it("lee rendimientos de 1 a 100 por ciento", () => {
    expect(leerRendimiento("85")).toBe(8500)
    expect(leerRendimiento("92,5 %")).toBe(9250)
    expect(leerRendimiento("0")).toBeNull()
    expect(leerRendimiento("101")).toBeNull()
  })
})

describe("existencias", () => {
  const lista = [ing("a", "Aceite", 2500, 3000), ing("b", "Bacon", 5000, 300), ing("c", "Cheddar", 0, 400), ing("d", "Dátiles", -20, 0), ing("e", "Eneldo", 100, 0, { active: false })]
  it("ordena primero lo que pide atención", () => {
    expect(ordenarExistencias(lista.slice(0, 4)).map((i) => i.id)).toEqual(["d", "c", "a", "b"])
    expect(lista.map(nivelDe)).toEqual(["low", "ok", "out", "negative", "ok"])
  })
  it("filtra por texto sin tildes, categoría, avisos e inactivos", () => {
    const base = { texto: "", categoria: "", soloAvisos: false, incluirInactivos: false }
    expect(filtrarExistencias(lista, { ...base, texto: "datil" }).map((i) => i.id)).toEqual(["d"])
    expect(filtrarExistencias(lista, { ...base, soloAvisos: true }).map((i) => i.id)).toEqual(["a", "c", "d"])
    expect(filtrarExistencias(lista, base)).toHaveLength(4)
    expect(filtrarExistencias(lista, { ...base, incluirInactivos: true })).toHaveLength(5)
    expect(filtrarExistencias(lista, { ...base, categoria: "Otra" })).toHaveLength(0)
  })
  it("resume sin contar los apagados", () => {
    expect(resumirExistencias(lista)).toEqual({ total: 4, conAviso: 3, agotados: 1, negativos: 1 })
  })
  it("escribe el coste por kilo con el coste medio", () => {
    expect(textoCosteUnitario(ing("p", "Patatas", 25000, 0), { valueCents: 3000, lastCost: null })).toContain("1,20")
    expect(textoCosteUnitario(ing("p", "Patatas", 0, 0), undefined)).toBe("Sin coste")
  })
})

describe("reconciliación del recuento", () => {
  it("descuenta lo movido desde que se contó, como el servidor", () => {
    // Había 1000 al contar, se vendieron 300 después: ahora hay 700. Se contaron 950.
    const r = reconciliar({ ingredientId: "a", countedQuantity: 950, countedAt: 1000 }, 700, [
      { ingredientId: "a", quantity: -300, at: 2000 },
      { ingredientId: "a", quantity: -50, at: 900 },
      { ingredientId: "b", quantity: -9, at: 2000 },
    ])
    expect(r).toMatchObject({ contado: 950, movido: -300, esperado: 1000, diferencia: -50 })
  })
  it("una línea sin contar no tiene diferencia", () => {
    expect(reconciliar({ ingredientId: "a", countedQuantity: null, countedAt: null }, 5, [])).toMatchObject({ diferencia: null })
  })
})

const plato = (id: string, variants: { id: string; price: number }[] = []): PlatoDoc =>
  ({ id, name: { es: id, ca: id, en: id }, sortOrder: 0, priceCents: 500, taxRate: 10, active: true, modifierGroups: [], variants: variants.map((v) => ({ id: v.id, name: { es: v.id, ca: v.id, en: v.id }, priceCents: v.price })) }) as unknown as PlatoDoc
const receta = (id: string, itemId: string, variantId: string | null, extra: Partial<RecipeWithId> = {}): RecipeWithId =>
  ({ id, name: id, itemId, variantId, lines: [], optionLines: {}, manualCostCents: 90, active: true, version: 2, ...extra })

describe("filas de platos", () => {
  it("una fila por variante, con receta propia o heredada de la común", () => {
    const filas = filasPlatos([plato("croq", [{ id: "media", price: 700 }, { id: "racion", price: 1200 }]), plato("sopa")], [receta("r1", "croq", "media"), receta("r2", "croq", null)])
    expect(filas.map((f) => [f.key, f.receta?.id ?? null, f.heredada, f.priceCents])).toEqual([
      ["croq:media", "r1", false, 700], ["croq:racion", "r2", true, 1200], ["sopa:-", null, false, 500],
    ])
  })
})

describe("borrador de receta", () => {
  const ingredientes = new Map([["a", { unit: "g" as const, name: "Patatas" }], ["b", { unit: "ml" as const, name: "Aceite" }]])
  const destino = { itemId: "bravas", variantId: null }
  it("convierte el formulario en la entrada del servidor", () => {
    const r = recetaDeBorrador({ name: " Bravas ", lines: [{ ingredientId: "a", cantidad: "250", rendimiento: "85" }, { ingredientId: "b", cantidad: "4 cl", rendimiento: "100" }], options: { extra: [] }, manual: "", active: true }, destino, ingredientes)
    expect(r).toEqual({ ok: true, receta: { name: "Bravas", itemId: "bravas", variantId: null, lines: [{ ingredientId: "a", quantity: 250, yieldBp: 8500 }, { ingredientId: "b", quantity: 40, yieldBp: 10000 }], optionLines: {}, manualCostCents: null, active: true } })
  })
  it("avisa de líneas sin ingrediente, cantidades malas, repetidos y mezcla con coste manual", () => {
    const r = recetaDeBorrador({ name: "x", lines: [{ ingredientId: "", cantidad: "1", rendimiento: "100" }, { ingredientId: "a", cantidad: "0,5", rendimiento: "100" }, { ingredientId: "b", cantidad: "1", rendimiento: "0" }], options: {}, manual: "2", active: true }, destino, ingredientes)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errores.length).toBeGreaterThanOrEqual(3)
    const rep = recetaDeBorrador({ name: "x", lines: [{ ingredientId: "a", cantidad: "1", rendimiento: "100" }, { ingredientId: "a", cantidad: "2", rendimiento: "100" }], options: {}, manual: "", active: true }, destino, ingredientes)
    expect(rep).toMatchObject({ ok: false, errores: ["Hay ingredientes repetidos en la receta."] })
  })
  it("ida y vuelta: el borrador de una receta guardada produce la misma receta", () => {
    const guardada = receta("r", "bravas", null, { manualCostCents: null, lines: [{ ingredientId: "a", quantity: 1500, yieldBp: 8500 }, { ingredientId: "b", quantity: 40, yieldBp: 10000 }], optionLines: { salsa: [{ ingredientId: "b", quantity: 10, yieldBp: 10000 }] } })
    const borrador = borradorDeReceta(guardada, "x", (id) => ingredientes.get(id)?.unit)
    expect(borrador.lines[0]).toMatchObject({ cantidad: "1500", rendimiento: "85" })
    const vuelta = recetaDeBorrador(borrador, destino, ingredientes)
    expect(vuelta.ok && vuelta.receta.lines).toEqual(guardada.lines)
    expect(vuelta.ok && vuelta.receta.optionLines).toEqual(guardada.optionLines)
  })
  it("calcula el coste con las funciones de core", () => {
    const patatas = ing("a", "Patatas", 10000, 0)
    const coste = costeDeReceta({ lines: [{ ingredientId: "a", quantity: 250, yieldBp: 8000 }], optionLines: {}, manualCostCents: null }, [patatas], new Map([["a", { valueCents: 1200, lastCost: null }]]))
    // 250 g con 80 % piden 313 g; a 1200 céntimos por 10 000 g son 38 céntimos.
    expect(coste).toEqual({ costCents: 38, complete: true, missing: [] })
    expect(costeDeReceta({ lines: [{ ingredientId: "a", quantity: 250, yieldBp: 8000 }], optionLines: {}, manualCostCents: null }, [patatas], new Map())).toMatchObject({ complete: false, missing: ["a"] })
  })
})

describe("versiones", () => {
  it("cuenta lo añadido, quitado y cambiado", () => {
    const nombre = (id: string) => id.toUpperCase()
    const a = { lines: [{ ingredientId: "a", quantity: 1, yieldBp: 10000 }, { ingredientId: "b", quantity: 1, yieldBp: 10000 }], manualCostCents: null }
    const b = { lines: [{ ingredientId: "a", quantity: 2, yieldBp: 10000 }, { ingredientId: "c", quantity: 1, yieldBp: 10000 }], manualCostCents: null }
    expect(diferenciasVersion(a, b, nombre)).toEqual(["Cambia A", "Añade C", "Quita B"])
  })
})
