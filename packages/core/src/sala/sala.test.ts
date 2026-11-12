import { describe, expect, it } from "vitest"
import {
  applyLineStatus,
  can,
  cancelTask,
  canSessionTransition,
  canTakeawayTransition,
  checkCancelSession,
  checkCloseSession,
  checkLineTransition,
  claimTask,
  completeTask,
  configuracionReservasInicial,
  defaultFloorSettings,
  findPickupSlot,
  floorTaskForWrite,
  FloorSettingsSchema,
  LINE_STATUSES,
  LINE_TRANSITIONS,
  lineTransitionPermissions,
  menuLineStatus,
  orderLineForWrite,
  OrderLineSchema,
  pickupSlots,
  planJoin,
  planMove,
  planOpen,
  planSplit,
  publicLineStatus,
  releaseTask,
  ROLES,
  sessionFromReservation,
  sessionLabel,
  sessionToOcupacion,
  sessionTotals,
  sortTasks,
  tableOccupancy,
  TableSessionSchema,
  tableQrPath,
  tablesAreJoinable,
  takeawayLabel,
  takeawayStatusFromLines,
  taskDedupeKey,
  taskDueAt,
  type FloorTask,
  type LineStatus,
  type OrderLine,
  type Role,
  type TableSessionStatus,
} from "../index"
import { linea, T0 } from "./datos-prueba"

const MIN = 60_000


describe("estados de una línea", () => {
  it("la tabla de transiciones cubre todos los estados y anulado es final", () => {
    expect(Object.keys(LINE_TRANSITIONS)).toEqual([...LINE_STATUSES])
    expect(LINE_TRANSITIONS.cancelled).toEqual([])
    for (const [from, tos] of Object.entries(LINE_TRANSITIONS)) for (const to of tos) expect(to).not.toBe(from)
  })

  it("cada cambio lo hace quien toca", () => {
    const quien = (from: LineStatus, to: LineStatus, kind: "kitchen" | "bar" | null): Role[] =>
      ROLES.filter((r) => lineTransitionPermissions(from, to, kind).some((p) => can(r, p)))
    // Marchar: la sala.
    expect(quien("held", "fired", "kitchen")).toEqual(["owner", "manager", "waiter"])
    // Empezar y terminar: la estación de su tipo.
    expect(quien("fired", "preparing", "kitchen")).toEqual(["owner", "manager", "kitchen"])
    expect(quien("preparing", "ready", "bar")).toEqual(["owner", "manager", "bar"])
    // Sin estación, lo hace la sala.
    expect(quien("fired", "ready", null)).toEqual(["owner", "manager", "waiter"])
    // Servir: la sala o la estación.
    expect(quien("ready", "served", "bar")).toEqual(["owner", "manager", "waiter", "bar"])
    // Anular antes de cocina: la sala; ya en cocina: solo con comandas.anular.
    expect(quien("held", "cancelled", "kitchen")).toEqual(["owner", "manager", "waiter"])
    expect(quien("preparing", "cancelled", "kitchen")).toEqual(["owner", "manager"])
    expect(quien("served", "cancelled", "kitchen")).toEqual(["owner", "manager"])
    // Lo que no está en la tabla, nadie.
    expect(quien("served", "fired", "kitchen")).toEqual([])
  })

  it("comprueba permisos, motivo y la línea del menú", () => {
    const camarero = (p: string) => can("waiter", p as never)
    const cocina = (p: string) => can("kitchen", p as never)
    const encargada = (p: string) => can("manager", p as never)
    expect(checkLineTransition(linea(), "preparing", cocina)).toEqual({ ok: true })
    expect(checkLineTransition(linea(), "preparing", camarero)).toEqual({ ok: false, reason: "No tienes permiso para este cambio." })
    expect(checkLineTransition(linea(), "cancelled", encargada).ok).toBe(false)
    expect(checkLineTransition(linea(), "cancelled", encargada, "el cliente se ha ido")).toEqual({ ok: true })
    expect(checkLineTransition(linea({ status: "held" }), "cancelled", camarero)).toEqual({ ok: true })
    expect(checkLineTransition(linea({ kind: "menu", stationId: null, stationKind: null }), "served", encargada).ok).toBe(false)
    expect(checkLineTransition(linea(), "fired", encargada).ok).toBe(false)
  })

  it("apunta las horas al avanzar y las borra al deshacer", () => {
    let l = linea({ status: "held", firedAt: null })
    l = applyLineStatus(l, "fired", T0 + MIN, "camarero")
    expect(l.firedAt).toBe(T0 + MIN)
    l = applyLineStatus(l, "preparing", T0 + 2 * MIN, "cocina")
    l = applyLineStatus(l, "ready", T0 + 9 * MIN, "cocina")
    expect([l.startedAt, l.readyAt]).toEqual([T0 + 2 * MIN, T0 + 9 * MIN])
    l = applyLineStatus(l, "preparing", T0 + 10 * MIN, "cocina")
    expect(l.readyAt).toBeNull()
    expect(l.startedAt).toBe(T0 + 2 * MIN)
    l = applyLineStatus(l, "served", T0 + 12 * MIN, "camarero")
    expect(l.servedAt).toBe(T0 + 12 * MIN)
    l = applyLineStatus(l, "cancelled", T0 + 13 * MIN, "encargada", "devuelto")
    expect(l.cancelReason).toBe("devuelto")
    expect(l.history.map((h) => `${h.from}>${h.to}`)).toEqual(["held>fired", "fired>preparing", "preparing>ready", "ready>preparing", "preparing>served", "served>cancelled"])
    // Desmarchar borra la hora de marcha.
    expect(applyLineStatus(linea(), "held", T0, "camarero").firedAt).toBeNull()
  })

  it("el estado del menú es el de su plato menos avanzado", () => {
    const s = (...st: LineStatus[]) => st.map((status) => ({ status }))
    expect(menuLineStatus(s("served", "fired", "held"))).toBe("held")
    expect(menuLineStatus(s("served", "ready"))).toBe("ready")
    expect(menuLineStatus(s("served", "cancelled"))).toBe("served")
    expect(menuLineStatus(s("cancelled", "cancelled"))).toBe("cancelled")
  })

  it("el cliente ve un estado sencillo", () => {
    expect(LINE_STATUSES.map(publicLineStatus)).toEqual(["pending", "held", "in_kitchen", "in_kitchen", "on_its_way", "served", "cancelled"])
  })

  it("se lee y se escribe con las horas convertidas", () => {
    const l = applyLineStatus(linea(), "preparing", T0 + MIN, "cocina")
    const w = orderLineForWrite(l, (ms) => ({ ms }))
    expect(w.firedAt).toEqual({ ms: T0 })
    expect(w.startedAt).toEqual({ ms: T0 + MIN })
    expect(w.readyAt).toBeNull()
    expect(w.history[0]?.at).toEqual({ ms: T0 + MIN })
    expect(OrderLineSchema.parse({ ...l, firedAt: { seconds: T0 / 1000, nanoseconds: 0 } }).firedAt).toBe(T0)
  })
})

describe("estados de la mesa y de para llevar", () => {
  it("mesa: pedir la cuenta, volver, cerrar, reabrir; juntada y anulada son finales", () => {
    const pares: Array<[TableSessionStatus, TableSessionStatus, boolean]> = [
      ["open", "bill_requested", true],
      ["bill_requested", "open", true],
      ["open", "closed", true],
      ["closed", "open", true],
      ["closed", "cancelled", false],
      ["merged", "open", false],
      ["cancelled", "open", false],
    ]
    for (const [a, b, ok] of pares) expect(canSessionTransition(a, b), `${a}>${b}`).toBe(ok)
  })

  it("para llevar pasa a listo cuando todo está listo", () => {
    expect(canTakeawayTransition("pending", "accepted")).toBe(true)
    expect(canTakeawayTransition("picked_up", "accepted")).toBe(false)
    const l = (status: LineStatus, kind: OrderLine["kind"] = "item") => ({ status, kind })
    expect(takeawayStatusFromLines("accepted", [l("ready"), l("served"), l("cancelled"), l("held", "menu")])).toBe("ready")
    expect(takeawayStatusFromLines("ready", [l("ready"), l("preparing")])).toBe("accepted")
    expect(takeawayStatusFromLines("pending", [l("ready")])).toBe("pending")
    expect(takeawayStatusFromLines("accepted", [l("cancelled")])).toBe("accepted")
  })
})

describe("mesas abiertas", () => {
  const mesas = {
    S1: { name: "S1", enabled: true, joinableWith: ["S2"] },
    S2: { name: "S2", enabled: true, joinableWith: [] },
    S3: { name: "S3", enabled: true, joinableWith: ["S4"] },
    S4: { name: "S4", enabled: true, joinableWith: [] },
    S10: { name: "S10", enabled: true, joinableWith: [] },
    T9: { name: "T9", enabled: false, joinableWith: [] },
  }
  const sesiones = [
    { id: "a", status: "open" as const, tableIds: ["S1"], guests: 2 },
    { id: "b", status: "bill_requested" as const, tableIds: ["S3", "S4"], guests: 6 },
    { id: "c", status: "closed" as const, tableIds: ["S2"], guests: 2 },
  ]
  const ocupacion = tableOccupancy(sesiones)

  it("ocupación y nombre", () => {
    expect(ocupacion).toEqual({ S1: "a", S3: "b", S4: "b" })
    expect(sessionLabel(["S10", "S2", "S1"], mesas)).toBe("S1+S2+S10")
    expect(tablesAreJoinable(["S1", "S2"], mesas)).toBe(true)
    expect(tablesAreJoinable(["S2", "S3"], mesas)).toBe(false)
  })

  it("abrir: mesas que existen, habilitadas y libres", () => {
    expect(planOpen(["S2"], mesas, ocupacion)).toEqual({ ok: true, label: "S2", joinable: true })
    expect(planOpen(["S1", "T9", "X"], mesas, ocupacion)).toEqual({
      ok: false,
      problems: [
        { code: "table_occupied", ref: "S1" },
        { code: "table_disabled", ref: "T9" },
        { code: "table_not_found", ref: "X" },
      ],
    })
  })

  it("mover a mesas libres; las propias cuentan como libres", () => {
    const a = sesiones[0] as (typeof sesiones)[number]
    expect(planMove(a, ["S2", "S1"], mesas, ocupacion)).toEqual({ ok: true, tableIds: ["S2", "S1"], label: "S1+S2", freedTableIds: [] })
    expect(planMove(a, ["S10"], mesas, ocupacion)).toMatchObject({ ok: true, freedTableIds: ["S1"] })
    expect(planMove(a, ["S3"], mesas, ocupacion)).toEqual({ ok: false, problems: [{ code: "table_occupied", ref: "S3" }] })
    expect(planMove(a, ["S1"], mesas, ocupacion)).toEqual({ ok: false, problems: [{ code: "same_tables", ref: null }] })
    expect(planMove(sesiones[2] as (typeof sesiones)[number], ["S10"], mesas, ocupacion).ok).toBe(false)
  })

  it("juntar: suma mesas libres y se trae otra mesa abierta entera", () => {
    const a = sesiones[0] as (typeof sesiones)[number]
    expect(planJoin(a, ["S2"], sesiones, mesas, ocupacion)).toEqual({
      ok: true,
      tableIds: ["S1", "S2"],
      label: "S1+S2",
      addedTableIds: ["S2"],
      mergedSessionIds: [],
      guests: 2,
      joinable: true,
    })
    expect(planJoin(a, ["S3"], sesiones, mesas, ocupacion)).toEqual({
      ok: true,
      tableIds: ["S1", "S3", "S4"],
      label: "S1+S3+S4",
      addedTableIds: [],
      mergedSessionIds: ["b"],
      guests: 8,
      joinable: false,
    })
    expect(planJoin(a, ["S1"], sesiones, mesas, ocupacion)).toEqual({ ok: false, problems: [{ code: "nothing_to_do", ref: null }] })
  })

  it("separar: libera mesas, o abre una mesa nueva con las líneas (el menú va entero)", () => {
    const b = sesiones[1] as (typeof sesiones)[number]
    const lineas = [
      { id: "l1", sessionId: "b", kind: "item" as const, parentLineId: null },
      { id: "m1", sessionId: "b", kind: "menu" as const, parentLineId: null },
      { id: "m1a", sessionId: "b", kind: "menu_component" as const, parentLineId: "m1" },
      { id: "x", sessionId: "otra", kind: "item" as const, parentLineId: null },
    ]
    expect(planSplit(b, ["S4"], [], lineas, mesas)).toEqual({ ok: true, keepTableIds: ["S3"], keepLabel: "S3", splitTableIds: ["S4"], splitLabel: "S4", movedLineIds: [], createsSession: false })
    expect(planSplit(b, ["S4"], ["m1"], lineas, mesas)).toMatchObject({ ok: true, movedLineIds: ["m1", "m1a"], createsSession: true })
    expect(planSplit(b, ["S3", "S4"], [], lineas, mesas)).toEqual({ ok: false, problems: [{ code: "would_leave_empty", ref: null }] })
    expect(planSplit(b, ["S4"], ["m1a", "x"], lineas, mesas)).toEqual({
      ok: false,
      problems: [
        { code: "line_is_menu_component", ref: "m1a" },
        { code: "line_not_in_session", ref: "x" },
      ],
    })
  })

  it("juntar rechaza el exceso de comensales sin recortar la suma", () => {
    const a = { ...sesiones[0]!, guests: 199 }
    expect(planJoin(a, ["S3"], sesiones, mesas, ocupacion)).toEqual({ ok: false, problems: [{ code: "too_many_guests", ref: null }] })
  })

  it("cerrar: nada por aceptar ni sin servir; anular: nada pedido", () => {
    const l = (status: LineStatus, kind: OrderLine["kind"] = "item") => ({ status, kind })
    expect(checkCloseSession([l("served"), l("cancelled"), l("held", "menu")])).toEqual([])
    expect(checkCloseSession([l("pending"), l("ready")]).map((p) => p.code)).toEqual(["lines_pending_approval", "lines_unserved"])
    expect(checkCancelSession([l("cancelled")])).toEqual([])
    expect(checkCancelSession([l("served")]).map((p) => p.code)).toEqual(["has_lines"])
  })

  it("total: suma lo no anulado; cuenta platos y menús, y lo que falta por servir", () => {
    const t = sessionTotals([
      { status: "served", kind: "item", totalCents: 1300 },
      { status: "cancelled", kind: "item", totalCents: 999 },
      { status: "held", kind: "menu", totalCents: 1550 },
      { status: "served", kind: "menu_component", totalCents: 0 },
      { status: "held", kind: "menu_component", totalCents: 400 },
    ])
    expect(t).toEqual({ totalCents: 1300 + 1550 + 400, lineCount: 2, unservedCount: 1 })
  })

  it("reservas: todas las sesiones abiertas ocupan sus mesas actuales para el motor", () => {
    const r = { tableIds: ["S3", "S4"], partySize: 5, customerId: "0123456789abcdef0123", guestName: "Ana Puig" }
    expect(sessionFromReservation(r, "res1")).toEqual({ tableIds: ["S3", "S4"], guests: 5, reservationId: "res1", customerId: "0123456789abcdef0123", guestName: "Ana Puig" })
    const s = { status: "open" as const, tableIds: ["S2"], guests: 3, openedAt: T0, reservationId: null }
    expect(sessionToOcupacion("x", s, 90)).toEqual({ id: "session:x", inicio: T0, duracionMinutos: 90, comensales: 3, estado: "sentada", mesaIds: ["S2"] })
    expect(sessionToOcupacion("x", { ...s, reservationId: "res1" }, 90)).toEqual(sessionToOcupacion("x", s, 90))
    expect(sessionToOcupacion("x", { ...s, status: "closed" }, 90)).toBeNull()
  })

  it("el esquema de la mesa abierta pide al menos una mesa", () => {
    const base = {
      status: "open",
      tableIds: ["S1"],
      label: "S1",
      guests: 2,
      reservationId: null,
      customerId: null,
      guestName: null,
      waiterUid: null,
      waiterName: null,
      notes: "",
      openedAt: T0,
      openedBy: "u",
      closedAt: null,
      closedBy: null,
      billRequestedAt: null,
      mergedInto: null,
      totalCents: 0,
      lineCount: 0,
      unservedCount: 0,
      history: [],
    }
    expect(TableSessionSchema.safeParse(base).success).toBe(true)
    expect(TableSessionSchema.safeParse({ ...base, tableIds: [] }).success).toBe(false)
    expect(TableSessionSchema.safeParse({ ...base, totalCents: 1.5 }).success).toBe(false)
  })
})

describe("tareas de sala", () => {
  const tarea = (cambios: Partial<FloorTask> = {}): FloorTask => ({
    type: "pickup",
    status: "open",
    sessionId: "s1",
    takeawayId: null,
    tableIds: ["S3"],
    label: "S3",
    orderId: null,
    stationId: "cocina",
    lineIds: ["l1"],
    note: "",
    dedupeKey: "pickup:session:s1:cocina",
    count: 1,
    openedAt: T0,
    dueAt: T0 + 3 * MIN,
    createdBy: null,
    claimedBy: null,
    claimedByName: null,
    claimedAt: null,
    doneAt: null,
    doneBy: null,
    ...cambios,
  })

  it("voy yo: la primera persona se la queda y la segunda recibe su nombre", () => {
    const r = claimTask(tarea(), "diego", "Diego Ríos", T0 + MIN)
    expect(r).toMatchObject({ ok: true, task: { status: "claimed", claimedBy: "diego", claimedByName: "Diego Ríos", claimedAt: T0 + MIN } })
    if (!r.ok) return
    expect(claimTask(r.task, "lucia", "Lucía Ferrer", T0 + 2 * MIN)).toEqual({ ok: false, reason: "taken", claimedBy: "diego", claimedByName: "Diego Ríos" })
    expect(claimTask(r.task, "diego", "Diego Ríos", T0 + 2 * MIN)).toEqual({ ok: true, task: r.task })
    expect(releaseTask(r.task, "lucia", false)).toEqual({ ok: false, reason: "not_owner" })
    expect(releaseTask(r.task, "laura", true)).toMatchObject({ ok: true, task: { status: "open", claimedBy: null } })
    expect(completeTask(r.task, "lucia", T0 + 3 * MIN)).toMatchObject({ ok: true, task: { status: "done", doneBy: "lucia" } })
    expect(claimTask(tarea({ status: "done" }), "diego", null, T0)).toEqual({ ok: false, reason: "closed" })
    expect(cancelTask(tarea({ status: "cancelled" }), "diego", T0)).toEqual({ ok: false, reason: "closed" })
  })

  it("claves para no duplicar y hora límite por tipo", () => {
    expect(taskDedupeKey("pickup", { sessionId: "s1", stationId: "cocina" })).toBe("pickup:session:s1:cocina")
    expect(taskDedupeKey("call_waiter", { tableId: "S3" })).toBe("call_waiter:table:S3")
    expect(taskDedupeKey("bill_request", { sessionId: "s1" })).toBe("bill_request:session:s1")
    expect(taskDedupeKey("approve_order", { orderId: "o1" })).toBe("approve_order:o1")
    expect(taskDedupeKey("custom", { sessionId: "s1" })).toBeNull()
    expect(taskDedupeKey("pickup", { takeawayId: "t1", stationId: "barra" })).toBe("pickup:takeaway:t1:barra")
    const targets = defaultFloorSettings().targets
    expect(taskDueAt("pickup", T0, targets)).toBe(T0 + 3 * MIN)
    expect(taskDueAt("custom", T0, targets)).toBe(T0 + 10 * MIN)
  })

  it("orden: lo que se cae primero, lo mío arriba, luego lo más antiguo", () => {
    const ts = [
      { id: "nueva", openedAt: T0 + 5 * MIN, dueAt: T0 + 8 * MIN, claimedBy: null },
      { id: "tarde", openedAt: T0 + MIN, dueAt: T0 + 4 * MIN, claimedBy: null },
      { id: "mia", openedAt: T0 + 6 * MIN, dueAt: T0 + 9 * MIN, claimedBy: "diego" },
      { id: "vieja", openedAt: T0, dueAt: T0 + 10 * MIN, claimedBy: null },
    ]
    expect(sortTasks(ts, T0 + 5 * MIN, "diego").map((t) => t.id)).toEqual(["tarde", "mia", "vieja", "nueva"])
    expect(floorTaskForWrite(tarea(), (ms) => `t${ms}`).dueAt).toBe(`t${T0 + 3 * MIN}`)
  })
})

describe("para llevar", () => {
  const config = configuracionReservasInicial("Europe/Madrid")
  const takeaway = { ...defaultFloorSettings().takeaway, enabled: true, stepMinutes: 30 as const, minNoticeMinutes: 30, maxOrdersPerSlot: 2 }

  it("franjas dentro de los turnos, con antelación y límite por franja", () => {
    // Martes 10 de noviembre: la configuración inicial abre comida y cena.
    const fecha = "2026-11-10"
    const ahora = Date.UTC(2026, 10, 10, 12, 10) // 13:10 en Madrid
    const todas = pickupSlots(config, takeaway, fecha, ahora, {})
    expect(todas.length).toBeGreaterThan(0)
    expect(todas.every((s) => s.wallDate === fecha)).toBe(true)
    const primera = todas[0]
    if (!primera) throw new Error("sin franjas")
    const llena = todas.find((s) => s.startAt >= ahora + 60 * MIN)
    if (!llena) throw new Error("sin franja futura")
    const slots = pickupSlots(config, takeaway, fecha, ahora, { [llena.startAt]: 2 })
    const de = (t: string) => slots.find((s) => s.time === t)
    // Las que caen antes de 13:40 no llegan a la antelación.
    for (const s of slots.filter((x) => x.startAt < ahora + 30 * MIN)) expect(s).toMatchObject({ available: false, reason: "min_notice" })
    expect(de(llena.time)).toMatchObject({ available: false, reason: "slot_full", orders: 2 })
    expect(findPickupSlot(slots, llena.time)).toBeNull()
    // El personal puede elegir una franja llena, pero no una que ya ha pasado.
    const personal = pickupSlots(config, takeaway, fecha, ahora, { [llena.startAt]: 2 }, true)
    expect(personal.find((s) => s.time === llena.time)?.available).toBe(true)
    expect(personal.filter((s) => s.startAt < ahora).every((s) => !s.available)).toBe(true)
  })

  it("etiqueta para la cocina y rutas", () => {
    expect(takeawayLabel("  Ana Puig Soler", "21:30")).toBe("Para llevar · Ana · 21:30")
    expect(tableQrPath("taberna-lumbre", "centro", "S3", "abc_DEF")).toBe("/m/taberna-lumbre/centro/S3?t=abc_DEF")
  })
})

describe("ajustes de sala", () => {
  it("los de por defecto cumplen el esquema y vienen apagados", () => {
    const s = defaultFloorSettings()
    expect(FloorSettingsSchema.parse(s)).toEqual(s)
    expect(s.selfOrder.enabled).toBe(false)
    expect(s.takeaway.enabled).toBe(false)
    expect(s.firing.mode).toBe("by_course")
  })
})
