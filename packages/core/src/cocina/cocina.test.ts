import { describe, expect, it } from "vitest"
import {
  autoFireAfterServe,
  delayFor,
  demoMenu,
  dueTakeawayLines,
  firingFor,
  groupByCourse,
  lateAlerts,
  lineDelay,
  linesToFire,
  nextHeldCourse,
  OrderLinesInputSchema,
  OrderLineSchema,
  planOrderLines,
  priceOrder,
  readyForPickup,
  resolveStation,
  sessionTotals,
  stationTickets,
  takeawayFiring,
  taskDelay,
  worstDelay,
  type LineDraft,
  type LineStatus,
  type OrderLine,
} from "../index"
import { linea, T0 } from "../sala/datos-prueba"

const MIN = 60_000
const LUNES_1330 = Date.UTC(2026, 10, 9, 12, 30)

function borradores(raw: unknown[]): LineDraft[] {
  const d = demoMenu()
  const r = priceOrder(OrderLinesInputSchema.parse(raw), { items: d.items, dailyMenus: d.dailyMenus }, { channel: "staff", now: LUNES_1330, timezone: "Europe/Madrid" })
  if (!r.ok) throw new Error(JSON.stringify(r.problems))
  return planOrderLines(r.lines, d.items, d.stations, d.settings)
}

describe("de pedido a líneas de cocina", () => {
  it("cada plato va a su estación con su pase y su tiempo objetivo", () => {
    const ls = borradores([
      { kind: "item", itemId: "cana", variantId: "cana", quantity: 2 },
      { kind: "item", itemId: "bravas", quantity: 1 },
      { kind: "item", itemId: "croquetas", variantId: "racion", quantity: 1, course: "second" },
      { kind: "item", itemId: "crema", quantity: 1 },
    ])
    expect(ls.map((l) => [l.key, l.itemId, l.course, l.stationId, l.stationKind, l.targetMinutes])).toEqual([
      ["0", "cana", "drinks", "barra", "bar", 4],
      ["1", "bravas", "first", "cocina", "kitchen", 8],
      ["2", "croquetas", "second", "cocina", "kitchen", 15],
      ["3", "crema", "dessert", "postres", "kitchen", 6],
    ])
  })

  it("un menú da su línea con el precio del menú y una línea por plato con su suplemento", () => {
    const ls = borradores([
      {
        kind: "menu",
        dailyMenuId: "mediodia",
        quantity: 2,
        selections: [
          { sectionId: "primeros", itemId: "sopa" },
          { sectionId: "segundos", itemId: "entrecot", optionIds: ["punto"] },
          { sectionId: "postres", itemId: "crema" },
        ],
      },
    ])
    expect(ls.map((l) => [l.key, l.parentKey, l.kind, l.course, l.stationId, l.unitPriceCents, l.totalCents, l.quantity])).toEqual([
      ["0", null, "menu", null, null, 1550, 3100, 2],
      ["0.1", "0", "menu_component", "first", "cocina", 0, 0, 2],
      ["0.2", "0", "menu_component", "second", "cocina", 400, 800, 2],
      ["0.3", "0", "menu_component", "dessert", "postres", 0, 0, 2],
    ])
    // La suma de las líneas da lo mismo que el precio calculado: (1550 + 400) × 2.
    expect(sessionTotals(ls.map((l) => ({ ...l, status: "fired" as LineStatus }))).totalCents).toBe(3900)
    expect(ls.map((l) => l.position)).toEqual([0, 1, 2, 3])
  })

  it("estación apagada o sin estación: la de por defecto, o ninguna", () => {
    const d = demoMenu()
    const st = { ...d.stations, postres: { ...(d.stations.postres as NonNullable<(typeof d.stations)["postres"]>), active: false } }
    expect(resolveStation("postres", st, "cocina")?.id).toBe("cocina")
    expect(resolveStation(null, st, "cocina")?.id).toBe("cocina")
    expect(resolveStation(null, st, null)).toBeNull()
    expect(resolveStation("borrada", {}, null)).toBeNull()
  })

  it("el precio congelado admite la suma de un precio base máximo y sus extras", () => {
    const d = demoMenu()
    const item = d.items.hamburguesa
    if (!item) throw new Error("Falta la hamburguesa.")
    const items = { ...d.items, hamburguesa: { ...item, priceCents: 10_000_000 } }
    const r = priceOrder(OrderLinesInputSchema.parse([{ kind: "item", itemId: "hamburguesa", optionIds: ["queso"], quantity: 99 }]), { items, dailyMenus: {} }, { channel: "staff", now: T0, timezone: "Europe/Madrid" })
    expect(r.ok).toBe(true)
    const draft = planOrderLines(r.lines, items, d.stations, d.settings)[0]
    if (!draft) throw new Error("Falta la línea.")
    expect(draft.unitPriceCents).toBe(10_000_150)
    expect(OrderLineSchema.parse({ ...linea(), ...draft }).totalCents).toBe(r.totalCents)
  })
})

describe("qué sale ya y qué espera", () => {
  const nuevas = (...cursos: Array<OrderLine["course"]>) => cursos.map((course, i) => ({ key: String(i), kind: "item" as const, course, parentKey: null }))
  const viva = (course: OrderLine["course"], status: LineStatus) => ({ kind: "item" as const, course, status })

  it("primeros y segundos juntos: salen los primeros y la bebida; los segundos esperan", () => {
    expect(firingFor(nuevas("drinks", "first", "second", "dessert"), [], "auto", "by_course")).toEqual({ 0: "fired", 1: "fired", 2: "held", 3: "held" })
  })

  it("si los primeros ya están servidos, los segundos salen; si siguen en cocina, esperan", () => {
    expect(firingFor(nuevas("second"), [viva("first", "served")], "auto", "by_course")).toEqual({ 0: "fired" })
    expect(firingFor(nuevas("second"), [viva("first", "preparing")], "auto", "by_course")).toEqual({ 0: "held" })
    // Un segundo más cuando ya hay segundos esperando: espera con ellos.
    expect(firingFor(nuevas("second"), [viva("first", "served"), viva("second", "held")], "auto", "by_course")).toEqual({ 0: "held" })
    // Un primero más cuando los segundos esperan: sale.
    expect(firingFor(nuevas("first"), [viva("second", "held")], "auto", "by_course")).toEqual({ 0: "fired" })
  })

  it("todo ya, todo espera y el modo de todo a la vez", () => {
    expect(firingFor(nuevas("first", "second"), [], "all", "by_course")).toEqual({ 0: "fired", 1: "fired" })
    expect(firingFor(nuevas("drinks", "first"), [], "hold", "by_course")).toEqual({ 0: "fired", 1: "held" })
    expect(firingFor(nuevas("first", "dessert"), [], "auto", "all_at_once")).toEqual({ 0: "fired", 1: "fired" })
  })

  it("la línea del menú sigue a su plato menos avanzado", () => {
    const ls = borradores([
      { kind: "menu", dailyMenuId: "mediodia", quantity: 1, selections: [{ sectionId: "primeros", itemId: "sopa" }, { sectionId: "segundos", itemId: "pollo" }, { sectionId: "postres", itemId: "crema" }] },
    ])
    expect(firingFor(ls, [], "auto", "by_course")).toEqual({ 0: "held", "0.1": "fired", "0.2": "held", "0.3": "held" })
    expect(firingFor(ls, [], "hold", "by_course")["0"]).toBe("held")
  })

  it("marchar el siguiente pase, uno concreto o todo", () => {
    const ls = [
      { id: "a", kind: "item" as const, course: "first" as const, status: "served" as LineStatus },
      { id: "b", kind: "item" as const, course: "second" as const, status: "held" as LineStatus },
      { id: "c", kind: "menu_component" as const, course: "second" as const, status: "held" as LineStatus },
      { id: "d", kind: "item" as const, course: "dessert" as const, status: "held" as LineStatus },
      { id: "m", kind: "menu" as const, course: null, status: "held" as LineStatus },
    ]
    expect(nextHeldCourse(ls)).toBe("second")
    expect(linesToFire(ls, null).map((l) => l.id)).toEqual(["b", "c"])
    expect(linesToFire(ls, "dessert").map((l) => l.id)).toEqual(["d"])
    expect(linesToFire(ls, "all").map((l) => l.id)).toEqual(["b", "c", "d"])
    expect(linesToFire([], null)).toEqual([])
  })

  it("marcha sola el siguiente pase al servir, si está activado", () => {
    const ls = [
      { id: "a", kind: "item" as const, course: "first" as const, status: "served" as LineStatus },
      { id: "b", kind: "item" as const, course: "drinks" as const, status: "fired" as LineStatus },
      { id: "c", kind: "item" as const, course: "second" as const, status: "held" as LineStatus },
    ]
    expect(autoFireAfterServe(ls, { firing: { mode: "by_course", autoFireNextCourse: false } })).toEqual([])
    expect(autoFireAfterServe(ls, { firing: { mode: "by_course", autoFireNextCourse: true } }).map((l) => l.id)).toEqual(["c"])
    const enCocina = [...ls, { id: "d", kind: "item" as const, course: "first" as const, status: "ready" as LineStatus }]
    expect(autoFireAfterServe(enCocina, { firing: { mode: "by_course", autoFireNextCourse: true } })).toEqual([])
  })

  it("para llevar sale a su hora: recogida menos la antelación", () => {
    const pickup = T0 + 60 * MIN
    expect(takeawayFiring([{ key: "0", kind: "item" }], pickup, 20, T0)).toEqual({ fireAt: pickup - 20 * MIN, statuses: { 0: "held" } })
    expect(takeawayFiring([{ key: "0", kind: "item" }], pickup, 20, pickup - 10 * MIN).statuses).toEqual({ 0: "fired" })
    expect(takeawayFiring([{ key: "0", kind: "item" }], pickup, 20, T0, "all").statuses).toEqual({ 0: "fired" })
    const ls = [
      linea({ status: "held", fireAt: T0 + 5 * MIN }),
      linea({ status: "held", fireAt: T0 + 50 * MIN }),
      linea({ status: "held", fireAt: null }),
    ]
    expect(dueTakeawayLines(ls, T0 + 10 * MIN)).toEqual([ls[0]])
  })
})

describe("pantalla de una estación", () => {
  const ls = [
    { ...linea({ orderId: "o1", label: "S3", position: 100, course: "second", status: "held", firedAt: null }), id: "a" },
    { ...linea({ orderId: "o1", label: "S3", position: 0, course: "first", status: "preparing", firedAt: T0 }), id: "b" },
    { ...linea({ orderId: "o2", label: "S5", position: 0, status: "fired", firedAt: T0 - 5 * MIN, placedAt: T0 - 5 * MIN }), id: "c" },
    { ...linea({ orderId: "o3", label: "T1", status: "ready", firedAt: T0 - 20 * MIN, readyAt: T0 - 4 * MIN, placedAt: T0 - 20 * MIN }), id: "d" },
    { ...linea({ orderId: "o4", label: "Para llevar · Ana · 22:00", status: "held", firedAt: null, fireAt: T0 + 40 * MIN }), id: "e" },
    { ...linea({ orderId: "o5", stationId: "barra", stationKind: "bar" }), id: "f" },
    { ...linea({ orderId: "o6", status: "served" }), id: "g" },
  ]

  it("una comanda por pedido: primero lo que hay que hacer, luego lo listo, luego lo que espera", () => {
    const tickets = stationTickets(ls, "cocina", T0 + 3 * MIN, 3)
    expect(tickets.map((t) => [t.orderId, t.status])).toEqual([
      ["o2", "active"],
      ["o1", "active"],
      ["o3", "ready"],
      ["o4", "held"],
    ])
    const o1 = tickets[1]
    expect(o1?.lines.map((l) => l.id)).toEqual(["b", "a"])
    expect(o1?.courses.map((c) => [c.course, c.lines.map((l) => l.id)])).toEqual([
      ["first", ["b"]],
      ["second", ["a"]],
    ])
    // o2 lleva 8 de 10 minutos: justo. o3 lleva 7 minutos listo con 3 de margen: tarde.
    expect(tickets[0]?.delay?.level).toBe("at_risk")
    expect(tickets[2]?.delay).toMatchObject({ level: "late", lateByMinutes: 4 })
    expect(tickets[3]?.fireAt).toBe(T0 + 40 * MIN)
  })

  it("agrupa lo listo por estación para las tareas de recoger", () => {
    const listas = [
      { id: "1", kind: "item" as const, status: "ready" as LineStatus, stationId: "cocina" },
      { id: "2", kind: "menu_component" as const, status: "ready" as LineStatus, stationId: "postres" },
      { id: "3", kind: "item" as const, status: "ready" as LineStatus, stationId: "barra" },
      { id: "4", kind: "item" as const, status: "preparing" as LineStatus, stationId: "cocina" },
    ]
    const st = { cocina: { pickup: true }, postres: { pickup: true }, barra: { pickup: false } }
    expect(readyForPickup(listas, st)).toEqual({ cocina: ["1"], postres: ["2"] })
  })

  it("agrupa por pases en su orden", () => {
    const g = groupByCourse([
      { course: "dessert" as const, position: 2 },
      { course: "first" as const, position: 1 },
      { course: "first" as const, position: 0 },
    ])
    expect(g.map((x) => [x.course, x.lines.map((l) => l.position)])).toEqual([
      ["first", [0, 1]],
      ["dessert", [2]],
    ])
  })

  it("separar una mesa conserva dos destinos en la pantalla de cocina aunque sea la misma comanda", () => {
    const tickets = stationTickets([
      { ...linea({ sessionId: "s1", label: "S3" }), id: "a" },
      { ...linea({ sessionId: "s2", label: "S4" }), id: "b" },
    ], "cocina", T0, 3)
    expect(tickets.map((t) => [t.orderId, t.sessionId, t.label, t.lines.map((l) => l.id)])).toEqual([
      ["o1", "s1", "S3", ["a"]],
      ["o1", "s2", "S4", ["b"]],
    ])
  })
})

describe("retrasos", () => {
  it("a tiempo, justo pasado el 75 % y tarde pasado el límite", () => {
    expect(delayFor(T0, T0 + 10 * MIN, T0 + 7 * MIN).level).toBe("on_time")
    expect(delayFor(T0, T0 + 10 * MIN, T0 + 8 * MIN).level).toBe("at_risk")
    expect(delayFor(T0, T0 + 10 * MIN, T0 + 10 * MIN).level).toBe("late")
    expect(delayFor(T0, T0 + 10 * MIN, T0 + 13 * MIN + 1)).toEqual({ level: "late", since: T0, dueAt: T0 + 10 * MIN, elapsedMinutes: 13, lateByMinutes: 3 })
  })

  it("el reloj de una línea depende de su estado", () => {
    expect(lineDelay(linea({ status: "held", firedAt: null }), T0, 3)).toBeNull()
    expect(lineDelay(linea({ status: "served" }), T0 + 60 * MIN, 3)).toBeNull()
    expect(lineDelay(linea({ status: "preparing" }), T0 + 11 * MIN, 3)?.level).toBe("late")
    expect(lineDelay(linea({ status: "ready", readyAt: T0 }), T0 + 3 * MIN, 3)?.level).toBe("late")
  })

  it("el peor de un grupo y las tareas", () => {
    const a = delayFor(T0, T0 + 10 * MIN, T0 + 5 * MIN)
    const b = delayFor(T0, T0 + 4 * MIN, T0 + 5 * MIN)
    expect(worstDelay([a, null, b])).toBe(b)
    expect(worstDelay([])).toBeNull()
    expect(taskDelay({ status: "claimed", openedAt: T0, dueAt: T0 + 3 * MIN }, T0 + 4 * MIN)?.level).toBe("late")
    expect(taskDelay({ status: "done", openedAt: T0, dueAt: T0 + 3 * MIN }, T0 + 4 * MIN)).toBeNull()
  })

  it("avisa una sola vez: solo lo que ha pasado a tarde desde la última comprobación", () => {
    const cosas = [
      { id: "a", dueAt: T0 + 1 * MIN },
      { id: "b", dueAt: T0 + 2 * MIN },
      { id: "c", dueAt: T0 + 5 * MIN },
    ]
    expect(lateAlerts(cosas, T0, T0 + 2 * MIN).map((x) => x.id)).toEqual(["a", "b"])
    expect(lateAlerts(cosas, T0 + 2 * MIN, T0 + 3 * MIN)).toEqual([])
    expect(lateAlerts(cosas, T0 + 3 * MIN, T0 + 6 * MIN).map((x) => x.id)).toEqual(["c"])
  })
})

it("los avisos locales también callan las tareas cogidas o cerradas", () => {
  const dueAt = T0 + MIN
  const tasks = [
    { id: "open", dueAt, status: "open", claimedBy: null },
    { id: "claimed", dueAt, status: "claimed", claimedBy: "lucia" },
    { id: "done", dueAt, status: "done", claimedBy: null },
  ]
  expect(lateAlerts(tasks, T0, T0 + 2 * MIN).map(t => t.id)).toEqual(["open"])
})
