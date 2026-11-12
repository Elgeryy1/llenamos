import { describe, expect, it } from "vitest"
import {
  addStock, alertAction, alertsApply, averageCost, canCountTransition, ceilDiv, checkPurchaseTransition, chooseSupplierItem, consumptionMovementId,
  consumptionSteps, costOfQuantity, costPerDisplayUnit, countDifference, dishMargin, emptyStock, formatQuantity, IngredientEditableSchema,
  lineConsumptionTarget, netOfGross, nextRecipeVersion, onOrderByIngredient, parseQuantity, pendingFormats, planConsumption, planCountAdjustments,
  planReceipt, planReversal, portionsPossible, purchaseTotal, PurchaseOrderSchema, recipeCost, RecipeEditableSchema, recipeRequirements,
  removeStock, requiredQuantity, resolveRecipe, stateAfterSteps, StockMovementSchema, stockLevel, suggestOrders, summarizeDishMargins, toBase,
  valueOfExtraUnits, areCompatibleUnits, baseUnitOf, unitCostOfFormat, PURCHASE_TRANSITIONS, stockMovementForWrite,
  type LineStatus, type PurchaseLine, type PurchaseOrder, type RecipeWithId, type StockState, type SupplierItemWithId,
} from "../index"

describe("unidades y cantidades enteras", () => {
  it("convierte a unidad base sin decimales y no mezcla familias", () => {
    expect(toBase(2, "kg")).toBe(2000)
    expect(toBase(3, "l")).toBe(3000)
    expect(toBase(5, "cl")).toBe(50)
    expect(toBase(7, "u")).toBe(7)
    expect(() => toBase(1.5, "kg")).toThrow()
    expect(() => toBase(Number.MAX_SAFE_INTEGER, "kg")).toThrow()
    expect(areCompatibleUnits("kg", "g")).toBe(true)
    expect(areCompatibleUnits("kg", "l")).toBe(false)
    expect(baseUnitOf("cl")).toBe("ml")
  })
  it("lee lo que escribe una persona y solo acepta lo que sale exacto", () => {
    expect(parseQuantity("1,5 kg", "g")).toBe(1500)
    expect(parseQuantity("250 g", "g")).toBe(250)
    expect(parseQuantity("250", "g")).toBe(250)
    expect(parseQuantity("2 l", "ml")).toBe(2000)
    expect(parseQuantity("1.25 L", "ml")).toBe(1250)
    expect(parseQuantity("3 ud", "u")).toBe(3)
    expect(parseQuantity("0,5 g", "g")).toBeNull()
    expect(parseQuantity("1,0005 kg", "g")).toBeNull()
    expect(parseQuantity("1,005 kg", "g")).toBe(1005)
    expect(parseQuantity("1 kg", "ml")).toBeNull()
    expect(parseQuantity("1 l", "u")).toBeNull()
    expect(parseQuantity("-3", "g")).toBeNull()
    expect(parseQuantity("tres", "g")).toBeNull()
    expect(parseQuantity("99999999999999999999 kg", "g")).toBeNull()
  })
  it("enseña la cantidad con la unidad que se lee mejor", () => {
    expect(formatQuantity(850, "g")).toBe("850 g")
    expect(formatQuantity(1250, "g")).toBe("1,25 kg")
    expect(formatQuantity(1000, "g")).toBe("1 kg")
    expect(formatQuantity(1005, "g")).toBe("1,005 kg")
    expect(formatQuantity(2050, "ml")).toBe("2,05 l")
    expect(formatQuantity(12, "u")).toBe("12 ud")
    expect(formatQuantity(-1500, "g")).toBe("-1,5 kg")
    expect(formatQuantity(0, "ml")).toBe("0 ml")
  })
})

describe("coste medio ponderado exacto", () => {
  it("valora al coste medio y se queda con el resto exacto", () => {
    let s: StockState = emptyStock()
    s = addStock(s, 5000, 4250, true).state
    expect(s).toEqual({ quantity: 5000, valueCents: 4250, lastCost: { cents: 4250, perBase: 5000 } })
    const paso = removeStock(s, 1000)
    expect(paso.valueCents).toBe(850)
    s = paso.state
    s = addStock(s, 2000, 2000, true).state
    expect(s).toMatchObject({ quantity: 6000, valueCents: 5400 })
    expect(averageCost(s)).toEqual({ cents: 5400, perBase: 6000 })
    const todo = removeStock(s, 6000)
    expect(todo.valueCents).toBe(5400)
    expect(todo.state).toMatchObject({ quantity: 0, valueCents: 0 })
  })
  it("el valor total sale entero aunque se consuma en trozos que no dividen", () => {
    let s = addStock(emptyStock(), 21, 100, true).state
    let fuera = 0
    for (let i = 0; i < 7; i++) {
      const p = removeStock(s, 3)
      fuera += p.valueCents
      s = p.state
      expect(s.valueCents).toBeGreaterThanOrEqual(0)
    }
    expect(fuera).toBe(100)
    expect(s).toMatchObject({ quantity: 0, valueCents: 0 })
  })
  it("vender sin existencias no se bloquea: queda en negativo y valora al último coste", () => {
    const s: StockState = { quantity: 100, valueCents: 200, lastCost: { cents: 200, perBase: 100 } }
    const paso = removeStock(s, 150)
    expect(paso).toMatchObject({ valueCents: 300, shortfall: 50, unpriced: false, state: { quantity: -50, valueCents: 0 } })
    // Una recepción posterior solo valora lo que sobra tras cubrir el déficit.
    const recibido = addStock(paso.state, 200, 500, true)
    expect(recibido.state).toMatchObject({ quantity: 150, valueCents: 375 })
    expect(addStock(paso.state, 50, 80, true).state).toMatchObject({ quantity: 0, valueCents: 0 })
    const sinCoste = removeStock(emptyStock(), 10)
    expect(sinCoste).toMatchObject({ valueCents: 0, unpriced: true, shortfall: 10, state: { quantity: -10 } })
  })
  it("devolver un consumo restituye cantidad y valor y no toca el último coste", () => {
    const s: StockState = { quantity: 1000, valueCents: 100, lastCost: { cents: 90, perBase: 1000 } }
    const salida = removeStock(s, 400)
    const vuelta = addStock(salida.state, 400, salida.valueCents, false)
    expect(vuelta.state).toEqual(s)
    expect(() => addStock(s, 0, 0, false)).toThrow()
    expect(() => removeStock(s, -1)).toThrow()
  })
  it("valora el sobrante de un recuento con el coste medio o, sin existencias, el último", () => {
    expect(valueOfExtraUnits({ quantity: 100, valueCents: 200, lastCost: null }, 10)).toBe(20)
    expect(valueOfExtraUnits({ quantity: 0, valueCents: 0, lastCost: { cents: 30, perBase: 100 } }, 50)).toBe(15)
    expect(valueOfExtraUnits(emptyStock(), 5)).toBe(0)
  })
  it("el coste por cantidad redondea al céntimo y se enseña por kg, l o ud", () => {
    expect(costOfQuantity({ cents: 850, perBase: 1000 }, 250)).toBe(213)
    expect(costOfQuantity({ cents: 850, perBase: 1000 }, 0)).toBe(0)
    expect(costPerDisplayUnit({ cents: 850, perBase: 1000 }, "g")).toEqual({ cents: 850, unit: "kg" })
    expect(costPerDisplayUnit({ cents: 1200, perBase: 12 }, "u")).toEqual({ cents: 100, unit: "ud" })
    expect(unitCostOfFormat(2500, 5000)).toEqual({ cents: 2500, perBase: 5000 })
    expect(() => unitCostOfFormat(2500, 0)).toThrow()
    expect(ceilDiv(9000, 5000)).toBe(2)
    expect(ceilDiv(0, 5)).toBe(0)
    expect(() => ceilDiv(1, 0)).toThrow()
  })
})

const receta = (extra: Partial<RecipeWithId> = {}): RecipeWithId => ({
  id: "r1", name: "Tortilla", itemId: "tortilla", variantId: null, version: 1, active: true, manualCostCents: null,
  lines: [{ ingredientId: "harina", quantity: 200, yieldBp: 10000 }, { ingredientId: "patata", quantity: 200, yieldBp: 8000 }],
  optionLines: { queso: [{ ingredientId: "queso", quantity: 30, yieldBp: 10000 }] }, ...extra,
})

describe("escandallos", () => {
  it("el rendimiento sube lo que hay que descontar, siempre hacia arriba", () => {
    expect(requiredQuantity({ quantity: 200, yieldBp: 8000 })).toBe(250)
    expect(requiredQuantity({ quantity: 200, yieldBp: 10000 })).toBe(200)
    expect(requiredQuantity({ quantity: 1, yieldBp: 3000 })).toBe(4)
    expect(requiredQuantity({ quantity: 100, yieldBp: 3333 })).toBe(301)
  })
  it("suma por ingrediente las raciones y los extras elegidos", () => {
    expect(recipeRequirements(receta(), { quantity: 2, optionIds: ["queso"] })).toEqual([
      { ingredientId: "harina", quantity: 400 }, { ingredientId: "patata", quantity: 500 }, { ingredientId: "queso", quantity: 60 },
    ])
    expect(recipeRequirements(receta(), { quantity: 1, optionIds: ["sin-receta", "queso", "queso"] }).map((r) => r.quantity)).toEqual([200, 250, 30])
    expect(() => recipeRequirements(receta(), { quantity: 0 })).toThrow()
    const repetido = receta({ lines: [{ ingredientId: "a", quantity: 10, yieldBp: 10000 }], optionLines: { x: [{ ingredientId: "a", quantity: 5, yieldBp: 10000 }] } })
    expect(recipeRequirements(repetido, { quantity: 3, optionIds: ["x"] })).toEqual([{ ingredientId: "a", quantity: 45 }])
  })
  it("calcula el coste de una ración y avisa de lo que no tiene coste", () => {
    const costes: Record<string, { cents: number; perBase: number }> = { harina: { cents: 100, perBase: 1000 }, patata: { cents: 300, perBase: 1000 }, queso: { cents: 1200, perBase: 1000 } }
    const de = (id: string) => costes[id] ?? null
    expect(recipeCost(receta(), de)).toEqual({ costCents: 95, complete: true, missing: [] })
    expect(recipeCost(receta(), de, ["queso"])).toEqual({ costCents: 131, complete: true, missing: [] })
    expect(recipeCost(receta(), (id) => (id === "patata" ? null : de(id)))).toEqual({ costCents: 20, complete: false, missing: ["patata"] })
    expect(recipeCost(receta({ lines: [], optionLines: {}, manualCostCents: 150 }), de)).toEqual({ costCents: 150, complete: true, missing: [] })
    expect(recipeCost(receta({ lines: [], optionLines: {}, manualCostCents: null }), de)).toEqual({ costCents: 0, complete: false, missing: [] })
  })
  it("elige la receta de la variante y, si no, la común", () => {
    const lista = [receta(), receta({ id: "r2", variantId: "media" }), receta({ id: "r3", active: false, variantId: "tapa" })]
    expect(resolveRecipe(lista, "tortilla", "media")?.id).toBe("r2")
    expect(resolveRecipe(lista, "tortilla", "tapa")?.id).toBe("r1")
    expect(resolveRecipe(lista, "tortilla", null)?.id).toBe("r1")
    expect(resolveRecipe(lista, "otro", null)).toBeNull()
  })
  it("margen sobre el precio sin IVA, con enteros", () => {
    expect(netOfGross(1100, 10)).toBe(1000)
    expect(netOfGross(1210, 21)).toBe(1000)
    expect(netOfGross(500, 0)).toBe(500)
    expect(dishMargin({ grossCents: 1100, taxRate: 10, costCents: 300 })).toEqual({ netCents: 1000, marginCents: 700, marginBp: 7000, foodCostBp: 3000 })
    expect(dishMargin({ grossCents: 1100, taxRate: 10, costCents: 1200 })).toMatchObject({ marginCents: -200, marginBp: -2000 })
    expect(dishMargin({ grossCents: 0, taxRate: 10, costCents: 5 })).toEqual({ netCents: 0, marginCents: -5, marginBp: null, foodCostBp: null })
  })
  it("raciones posibles con lo que hay, sin tocar el contador diario", () => {
    expect(portionsPossible(receta(), (id) => ({ harina: 1000, patata: 600 })[id] ?? 0)).toBe(2)
    expect(portionsPossible(receta(), (id) => ({ harina: 1000, patata: -5 })[id] ?? 0)).toBe(0)
    expect(portionsPossible(receta({ lines: [] }), () => 100)).toBeNull()
  })
  it("la versión de la receta sube solo si cambia lo que consume o cuesta", () => {
    const r = receta()
    const mismo = { lines: [...r.lines].reverse(), optionLines: r.optionLines, manualCostCents: null }
    expect(nextRecipeVersion(r, mismo)).toBe(1)
    expect(nextRecipeVersion(r, { ...mismo, lines: [{ ingredientId: "harina", quantity: 210, yieldBp: 10000 }, r.lines[1]!] })).toBe(2)
    expect(nextRecipeVersion(r, { ...mismo, optionLines: {} })).toBe(2)
    expect(nextRecipeVersion(r, { lines: [], optionLines: {}, manualCostCents: 100 })).toBe(2)
  })
  it("una receta usa ingredientes o coste manual, y no repite ingredientes", () => {
    const base = { name: "Tortilla", itemId: "tortilla", variantId: null, lines: [{ ingredientId: "a", quantity: 1, yieldBp: 10000 }], optionLines: {}, manualCostCents: null, active: true }
    expect(RecipeEditableSchema.safeParse(base).success).toBe(true)
    expect(RecipeEditableSchema.safeParse({ ...base, manualCostCents: 100 }).success).toBe(false)
    expect(RecipeEditableSchema.safeParse({ ...base, lines: [base.lines[0], base.lines[0]] }).success).toBe(false)
    expect(RecipeEditableSchema.safeParse({ ...base, lines: [{ ingredientId: "a", quantity: 1.5, yieldBp: 10000 }] }).success).toBe(false)
    expect(RecipeEditableSchema.safeParse({ ...base, lines: [{ ingredientId: "a", quantity: 1, yieldBp: 0 }] }).success).toBe(false)
  })
})

describe("descuento al vender, al anular y por merma", () => {
  const h = (to: LineStatus) => ({ to })
  it("consume al marchar y no antes", () => {
    for (const s of ["fired", "preparing", "ready", "served"] as const) expect(lineConsumptionTarget(s, [])).toBe("consumed")
    for (const s of ["pending", "held"] as const) expect(lineConsumptionTarget(s, [h("fired")])).toBe("reversed")
  })
  it("anular antes de cocinar devuelve; después de empezar es pérdida", () => {
    expect(lineConsumptionTarget("cancelled", [h("fired")])).toBe("reversed")
    expect(lineConsumptionTarget("cancelled", [])).toBe("reversed")
    expect(lineConsumptionTarget("cancelled", [h("fired"), h("preparing")])).toBe("wasted")
    expect(lineConsumptionTarget("cancelled", [h("fired"), h("served")])).toBe("wasted")
    expect(lineConsumptionTarget("cancelled", [h("fired"), h("ready"), h("preparing")])).toBe("wasted")
  })
  it("los pasos salen del estado actual y el objetivo, y repetirlos no hace nada", () => {
    expect(consumptionSteps("none", "consumed")).toEqual(["consume"])
    expect(consumptionSteps("none", "reversed")).toEqual([])
    expect(consumptionSteps("none", "wasted")).toEqual(["consume", "mark_wasted"])
    expect(consumptionSteps("consumed", "consumed")).toEqual([])
    expect(consumptionSteps("consumed", "reversed")).toEqual(["reverse"])
    expect(consumptionSteps("consumed", "wasted")).toEqual(["mark_wasted"])
    expect(consumptionSteps("reversed", "consumed")).toEqual(["consume"])
    expect(consumptionSteps("reversed", "reversed")).toEqual([])
    expect(consumptionSteps("wasted", "consumed")).toEqual([])
    expect(consumptionSteps("no_recipe", "reversed")).toEqual([])
    let estado = stateAfterSteps("none", consumptionSteps("none", "consumed"))
    expect(estado).toBe("consumed")
    estado = stateAfterSteps(estado, consumptionSteps(estado, "reversed"))
    expect(estado).toBe("reversed")
    estado = stateAfterSteps(estado, consumptionSteps(estado, "wasted"))
    expect(estado).toBe("wasted")
    expect(stateAfterSteps(estado, consumptionSteps(estado, "wasted"))).toBe("wasted")
  })
  it("descuenta sin bloquear y devuelve exactamente lo consumido", () => {
    const stocks = new Map<string, StockState>([
      ["harina", { quantity: 1000, valueCents: 100, lastCost: { cents: 100, perBase: 1000 } }],
      ["patata", { quantity: 100, valueCents: 30, lastCost: { cents: 30, perBase: 100 } }],
    ])
    const plan = planConsumption([{ ingredientId: "harina", quantity: 400 }, { ingredientId: "patata", quantity: 500 }], stocks)
    expect(plan.movements.map((m) => [m.ingredientId, m.quantity, m.valueCents, m.shortfall])).toEqual([["harina", -400, -40, 0], ["patata", -500, -150, 400]])
    expect(plan).toMatchObject({ costCents: 190, complete: true })
    expect(plan.movements[1]!.state.quantity).toBe(-400)
    const despues = new Map(plan.movements.map((m) => [m.ingredientId, m.state]))
    const vuelta = planReversal(plan.movements, despues)
    expect(vuelta.map((m) => [m.ingredientId, m.quantity, m.valueCents])).toEqual([["harina", 400, 40], ["patata", 500, 150]])
    expect(vuelta[0]!.state).toEqual(stocks.get("harina"))
    expect(vuelta[1]!.state).toMatchObject({ quantity: 100, valueCents: 30 })
  })
  it("sin coste conocido el coste de la línea queda incompleto", () => {
    const plan = planConsumption([{ ingredientId: "nuevo", quantity: 10 }], new Map())
    expect(plan).toMatchObject({ costCents: 0, complete: false })
    expect(plan.movements[0]).toMatchObject({ unpriced: true, shortfall: 10 })
  })
  it("el id del movimiento es determinista por línea, ciclo y tipo", () => {
    expect(consumptionMovementId("l1", 2, "c", "harina")).toBe("l1.2.c.harina")
    expect(consumptionMovementId("l1", 2, "r", "harina")).not.toBe(consumptionMovementId("l1", 3, "r", "harina"))
  })
})

describe("recuento y reconciliación", () => {
  it("compara con lo que decía el libro cuando se contó, no con lo de ahora", () => {
    expect(countDifference({ currentQuantity: 80, movedSinceCount: -10, counted: 100 })).toBe(10)
    expect(countDifference({ currentQuantity: 80, movedSinceCount: 0, counted: 80 })).toBe(0)
    expect(countDifference({ currentQuantity: 30, movedSinceCount: 50, counted: 0 })).toBe(20)
    expect(() => countDifference({ currentQuantity: 1, movedSinceCount: 0, counted: -1 })).toThrow()
    expect(() => countDifference({ currentQuantity: 1.5, movedSinceCount: 0, counted: 1 })).toThrow()
  })
  it("ajusta al alza con coste medio y a la baja con pérdida valorada", () => {
    const stocks = new Map<string, StockState>([
      ["a", { quantity: 100, valueCents: 200, lastCost: null }], ["b", { quantity: 100, valueCents: 200, lastCost: null }],
      ["c", { quantity: 5, valueCents: 5, lastCost: null }], ["d", { quantity: 7, valueCents: 7, lastCost: null }],
    ])
    const r = planCountAdjustments(
      [{ ingredientId: "d", countedQuantity: 7 }, { ingredientId: "b", countedQuantity: 120 }, { ingredientId: "a", countedQuantity: 90 }, { ingredientId: "c", countedQuantity: null }],
      stocks, new Map(),
    )
    expect(r.adjustments.map((x) => [x.ingredientId, x.quantity, x.valueCents])).toEqual([["a", -10, -20], ["b", 20, 40]])
    expect(r.adjustments[0]!.state).toMatchObject({ quantity: 90, valueCents: 180 })
    expect(r.adjustments[1]!.state).toMatchObject({ quantity: 120, valueCents: 240 })
    expect(r.uncounted).toEqual(["c"])
    expect(r.unchanged).toEqual(["d"])
    // Si se vendieron 10 después de contar, lo contado (90) ya cuadraba con el libro de entonces (100 - 10 vendidos aún no contados).
    const seguido = planCountAdjustments([{ ingredientId: "a", countedQuantity: 100 }], new Map([["a", { quantity: 90, valueCents: 180, lastCost: null }]]), new Map([["a", -10]]))
    expect(seguido.adjustments).toEqual([])
    expect(seguido.unchanged).toEqual(["a"])
  })
  it("un recuento aplicado o cancelado no se reabre", () => {
    expect(canCountTransition("draft", "applied")).toBe(true)
    expect(canCountTransition("draft", "cancelled")).toBe(true)
    expect(canCountTransition("applied", "draft")).toBe(false)
    expect(canCountTransition("cancelled", "applied")).toBe(false)
  })
})

describe("mínimos y avisos", () => {
  it("el nivel sale de la cantidad y el mínimo", () => {
    expect(stockLevel(-1, 5)).toBe("negative")
    expect(stockLevel(0, 5)).toBe("out")
    expect(stockLevel(5, 5)).toBe("low")
    expect(stockLevel(6, 5)).toBe("ok")
    expect(stockLevel(3, 0)).toBe("ok")
    expect(stockLevel(0, 0)).toBe("out")
  })
  it("un aviso por ingrediente: abre, solo vuelve a sonar si empeora y se resuelve al reponer", () => {
    expect(alertAction(null, "ok")).toEqual({ action: "none" })
    expect(alertAction(null, "low")).toEqual({ action: "open", level: "low" })
    expect(alertAction({ status: "resolved", level: "low" }, "low")).toEqual({ action: "open", level: "low" })
    expect(alertAction({ status: "open", level: "low" }, "low")).toEqual({ action: "none" })
    expect(alertAction({ status: "acknowledged", level: "low" }, "out")).toEqual({ action: "escalate", level: "out" })
    expect(alertAction({ status: "open", level: "negative" }, "out")).toEqual({ action: "update", level: "out" })
    expect(alertAction({ status: "acknowledged", level: "out" }, "ok")).toEqual({ action: "resolve" })
    expect(alertAction({ status: "resolved", level: "out" }, "ok")).toEqual({ action: "none" })
  })
  it("sin mínimo o con avisos apagados no se crean avisos", () => {
    expect(alertsApply({ lowStockAlerts: true }, { minQuantity: 10 })).toBe(true)
    expect(alertsApply({ lowStockAlerts: true }, { minQuantity: 0 })).toBe(false)
    expect(alertsApply({ lowStockAlerts: false }, { minQuantity: 10 })).toBe(false)
  })
})

const linea = (extra: Partial<PurchaseLine> = {}): PurchaseLine => ({ lineId: "l1", supplierItemId: "i1", ingredientId: "aceite", name: "Garrafa 5 l", baseQuantity: 5000, priceCents: 2500, orderedFormats: 4, receivedFormats: 0, ...extra })
const pedido = (extra: Partial<PurchaseOrder> = {}): PurchaseOrder => ({
  supplierId: "s1", reference: "ABC123", status: "sent", lines: [linea(), linea({ lineId: "l2", supplierItemId: "i2", ingredientId: "harina", name: "Saco 25 kg", baseQuantity: 25000, priceCents: 1800, orderedFormats: 2 })],
  expectedOn: null, notes: "", totalCents: 13600, createdBy: "enc", sentAt: 1, closedReason: null, revision: 1, ...extra,
})
const item = (id: string, extra: Partial<SupplierItemWithId> = {}): SupplierItemWithId => ({
  id, supplierId: "s1", ingredientId: "aceite", name: "Garrafa 5 l", sku: null, baseQuantity: 5000, priceCents: 2500, preferred: false, active: true,
  lastPriceCents: null, lastReceivedAt: null, ...extra,
})
const items = new Map([["i1", item("i1")], ["i2", item("i2", { ingredientId: "harina", baseQuantity: 25000, priceCents: 1800, lastPriceCents: 1750 })], ["i9", item("i9", { supplierId: "s2" })]])

describe("pedidos a proveedor y recepción parcial", () => {
  it("los estados siguen su recorrido y no hay vuelta atrás", () => {
    expect(PURCHASE_TRANSITIONS.draft).toEqual(["sent", "cancelled"])
    expect(checkPurchaseTransition(pedido({ status: "draft" }), "sent", null)).toEqual({ ok: true })
    expect(checkPurchaseTransition(pedido({ status: "received" }), "sent", null)).toMatchObject({ ok: false })
    expect(checkPurchaseTransition(pedido(), "cancelled", " ")).toMatchObject({ ok: false, message: "Escribe el motivo." })
    expect(checkPurchaseTransition(pedido(), "cancelled", "Cambio de proveedor")).toEqual({ ok: true })
    expect(checkPurchaseTransition(pedido({ status: "partially_received", lines: [linea({ receivedFormats: 1 })] }), "closed", "No llegará el resto")).toEqual({ ok: true })
    expect(checkPurchaseTransition(pedido({ status: "partially_received" }), "cancelled", "x")).toMatchObject({ ok: false })
    expect(checkPurchaseTransition(pedido({ lines: [linea({ receivedFormats: 1 })] }), "cancelled", "x")).toMatchObject({ ok: false })
    expect(purchaseTotal(pedido().lines)).toBe(13600)
  })
  it("recibe en dos veces: primero parcial, luego completo y de más", () => {
    const primera = planReceipt(pedido(), "s1", items, [{ supplierItemId: "i1", receivedFormats: 3, priceCents: 2500 }, { supplierItemId: "i2", receivedFormats: 2, priceCents: 1800 }])
    expect(primera.totalCents).toBe(11100)
    expect(primera.movements).toEqual([{ ingredientId: "aceite", quantity: 15000, valueCents: 7500 }, { ingredientId: "harina", quantity: 50000, valueCents: 3600 }])
    expect(primera.status).toBe("partially_received")
    expect(primera.pending).toEqual([{ lineId: "l1", formats: 1 }])
    expect(primera.exceeded).toEqual([])
    expect(primera.priceChanges).toEqual([{ supplierItemId: "i2", previousCents: 1750, newCents: 1800, changeBp: 286 }])
    expect(primera.lines[0]).toMatchObject({ purchaseLineId: "l1", receivedBase: 15000, totalCents: 7500 })
    const segundo = planReceipt(pedido({ status: "partially_received", lines: primera.orderLines! }), "s1", items, [{ supplierItemId: "i1", receivedFormats: 2, priceCents: 2600 }])
    expect(segundo.status).toBe("received")
    expect(segundo.exceeded).toEqual([{ lineId: "l1", extraFormats: 1 }])
    expect(segundo.priceChanges).toEqual([{ supplierItemId: "i1", previousCents: 2500, newCents: 2600, changeBp: 400 }])
    expect(segundo.orderLines![0]!.receivedFormats).toBe(5)
  })
  it("rechaza albaranes que no cuadran", () => {
    const una = [{ supplierItemId: "i1", receivedFormats: 1, priceCents: 2500 }]
    expect(() => planReceipt(pedido(), "s2", items, una)).toThrow("otro proveedor")
    expect(() => planReceipt(pedido({ status: "draft" }), "s1", items, una)).toThrow("no admite")
    expect(() => planReceipt(pedido({ status: "received" }), "s1", items, una)).toThrow("no admite")
    expect(() => planReceipt(pedido(), "s1", items, [...una, ...una])).toThrow("repetidos")
    expect(() => planReceipt(pedido(), "s1", items, [])).toThrow("no tiene líneas")
    expect(() => planReceipt(pedido(), "s1", items, [{ supplierItemId: "i1", receivedFormats: 0, priceCents: 1 }])).toThrow("mayor que cero")
    expect(() => planReceipt(pedido(), "s1", items, [{ supplierItemId: "i1", receivedFormats: 1, priceCents: 1.5 }])).toThrow("céntimos")
    expect(() => planReceipt(pedido(), "s1", items, [{ supplierItemId: "nada", receivedFormats: 1, priceCents: 1 }])).toThrow("no es de este proveedor")
    expect(() => planReceipt(pedido(), "s1", items, [{ supplierItemId: "i9", receivedFormats: 1, priceCents: 1 }])).toThrow("no es de este proveedor")
    expect(() => planReceipt(pedido({ lines: [linea()] }), "s1", items, [{ supplierItemId: "i2", receivedFormats: 1, priceCents: 1 }])).toThrow("no está en el pedido")
  })
  it("una compra directa no necesita pedido pero sí un formato activo", () => {
    const directa = planReceipt(null, "s1", items, [{ supplierItemId: "i1", receivedFormats: 1, priceCents: 2500 }])
    expect(directa).toMatchObject({ orderLines: null, status: null, pending: [], totalCents: 2500 })
    expect(directa.lines[0]!.purchaseLineId).toBeNull()
    const apagado = new Map(items).set("i1", item("i1", { active: false }))
    expect(() => planReceipt(null, "s1", apagado, [{ supplierItemId: "i1", receivedFormats: 1, priceCents: 1 }])).toThrow("desactivado")
  })
  it("lo pendiente no baja de cero", () => {
    expect(pendingFormats([linea({ receivedFormats: 5 }), linea({ lineId: "l2", receivedFormats: 1 })])).toEqual([{ lineId: "l2", formats: 3 }])
  })
})

describe("sugerencia de pedidos", () => {
  const suppliers = new Map([["s1", { minOrderCents: 6000, active: true }], ["s2", { minOrderCents: 0, active: true }], ["s3", { minOrderCents: 0, active: false }]])
  const formatos = [
    item("i1", { preferred: true }), item("i3", { supplierId: "s2", priceCents: 2000 }),
    item("i4", { supplierId: "s2", ingredientId: "sal", baseQuantity: 1000, priceCents: 100 }),
    item("i5", { supplierId: "s3", ingredientId: "pimienta", baseQuantity: 100, priceCents: 300 }),
  ]
  const ing = (id: string, quantity: number, minQuantity: number, targetQuantity: number | null = null, active = true) => ({ id, quantity, minQuantity, targetQuantity, active })
  it("pide hasta el objetivo en formatos enteros y agrupa por proveedor", () => {
    const r = suggestOrders(
      [ing("aceite", 1000, 3000, 10000), ing("harina", 20000, 5000), ing("sal", 0, 500), ing("pan", 0, 0), ing("azucar", 0, 100), ing("pimienta", 0, 10), ing("viejo", 0, 10, null, false)],
      formatos, suppliers, new Map(),
    )
    expect(r.orders).toEqual([
      { supplierId: "s1", lines: [{ supplierItemId: "i1", ingredientId: "aceite", formats: 2, totalCents: 5000 }], totalCents: 5000, belowMinimum: true },
      { supplierId: "s2", lines: [{ supplierItemId: "i4", ingredientId: "sal", formats: 1, totalCents: 100 }], totalCents: 100, belowMinimum: false },
    ])
    expect(r.withoutSupplier).toEqual(["azucar", "pimienta"])
  })
  it("descuenta lo que ya viene en pedidos abiertos", () => {
    const abiertos = [pedido({ lines: [linea({ receivedFormats: 1 })] }), pedido({ status: "received" })]
    const enCamino = onOrderByIngredient(abiertos)
    expect(enCamino.get("aceite")).toBe(15000)
    expect(suggestOrders([ing("aceite", 1000, 3000, 10000)], formatos, suppliers, enCamino).orders).toEqual([])
  })
  it("sin preferido elige el formato más barato por unidad base", () => {
    const barato = chooseSupplierItem([item("a", { priceCents: 2500 }), item("b", { priceCents: 4000, baseQuantity: 10000 }), item("c", { priceCents: 100, active: false })])
    expect(barato?.id).toBe("b")
    expect(chooseSupplierItem([item("c", { active: false })])).toBeNull()
    expect(chooseSupplierItem([item("z", { preferred: true }), item("b", { priceCents: 1 })])?.id).toBe("z")
  })
})

describe("margen histórico por plato", () => {
  const l = (extra: Partial<Parameters<typeof summarizeDishMargins>[0][number]>): Parameters<typeof summarizeDishMargins>[0][number] => ({
    itemId: "a", variantId: null, menuComponent: false, quantity: 1, state: "consumed", costCents: 300, complete: true, grossCents: 1100, taxRate: 10, ...extra,
  })
  it("congela ingreso y coste del momento, separa pérdidas y platos de menú", () => {
    const filas = summarizeDishMargins([
      l({ quantity: 2, grossCents: 2200, costCents: 600 }), l({}), l({ state: "no_recipe", costCents: null }), l({ state: "reversed" }),
      l({ state: "wasted" }), l({ itemId: "b", menuComponent: true, grossCents: 200, costCents: 500 }), l({ itemId: "c", costCents: 100, complete: false }),
    ])
    expect(filas).toHaveLength(3)
    expect(filas[0]).toEqual({ itemId: "a", variantId: null, inMenu: false, units: 4, coveredUnits: 3, grossCents: 4400, netCents: 4000, coveredNetCents: 3000, costCents: 900, wasteCostCents: 300, marginCents: 2100, marginBp: 7000 })
    expect(filas[1]).toMatchObject({ itemId: "b", inMenu: true, units: 1, costCents: 500 })
    expect(filas[2]).toMatchObject({ itemId: "c", units: 1, coveredUnits: 0, costCents: 0, marginBp: null })
  })
})

describe("documentos", () => {
  it("un movimiento tiene el sentido, el motivo y la referencia que le tocan", () => {
    const base = { ingredientId: "harina", quantity: 1000, valueCents: 100, quantityAfter: 1000, at: 1, by: "enc", reason: null, wasteReason: null, lineId: null, receiptId: "r1", countId: null, requestId: null }
    expect(StockMovementSchema.safeParse({ ...base, kind: "receipt" }).success).toBe(true)
    expect(StockMovementSchema.safeParse({ ...base, kind: "sale", quantity: 100, valueCents: 10, lineId: "l1" }).success).toBe(false)
    expect(StockMovementSchema.safeParse({ ...base, kind: "sale", quantity: -100, valueCents: -10, lineId: null }).success).toBe(false)
    expect(StockMovementSchema.safeParse({ ...base, kind: "sale", quantity: -100, valueCents: -10, lineId: "l1" }).success).toBe(true)
    expect(StockMovementSchema.safeParse({ ...base, kind: "receipt", quantity: -5, valueCents: -5 }).success).toBe(false)
    expect(StockMovementSchema.safeParse({ ...base, kind: "waste", quantity: -5, valueCents: -5 }).success).toBe(false)
    expect(StockMovementSchema.safeParse({ ...base, kind: "waste", quantity: -5, valueCents: -5, wasteReason: "expired" }).success).toBe(true)
    expect(StockMovementSchema.safeParse({ ...base, kind: "adjustment", quantity: -5, valueCents: -5 }).success).toBe(false)
    expect(StockMovementSchema.safeParse({ ...base, kind: "adjustment", quantity: -5, valueCents: 5, reason: "x" }).success).toBe(false)
    expect(StockMovementSchema.safeParse({ ...base, kind: "receipt", quantity: 0 }).success).toBe(false)
    expect(stockMovementForWrite(StockMovementSchema.parse({ ...base, kind: "receipt" }), (ms) => ({ ts: ms })).at).toEqual({ ts: 1 })
  })
  it("el objetivo de reposición no baja del mínimo y las cantidades son enteras", () => {
    const base = { name: "Harina", unit: "g", category: null, minQuantity: 1000, targetQuantity: 5000, active: true }
    expect(IngredientEditableSchema.safeParse(base).success).toBe(true)
    expect(IngredientEditableSchema.safeParse({ ...base, targetQuantity: 500 }).success).toBe(false)
    expect(IngredientEditableSchema.safeParse({ ...base, minQuantity: 10.5 }).success).toBe(false)
    expect(IngredientEditableSchema.safeParse({ ...base, unit: "kg" }).success).toBe(false)
  })
  it("un pedido no repite líneas", () => {
    expect(PurchaseOrderSchema.safeParse(pedido()).success).toBe(true)
    expect(PurchaseOrderSchema.safeParse(pedido({ lines: [linea(), linea()] })).success).toBe(false)
    expect(PurchaseOrderSchema.safeParse(pedido({ reference: "abc" })).success).toBe(false)
  })
})
