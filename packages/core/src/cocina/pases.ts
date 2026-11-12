/**
 * De un pedido calculado a líneas de cocina: estación, pase, estado inicial y comandas.
 *
 * 1. `planOrderLines` convierte las líneas calculadas (`priceOrder`) en borradores de
 *    `orderLines`: un plato da una línea; un menú da su línea (con el precio del menú) y una
 *    línea por plato elegido (con su suplemento), cada una con su estación y su pase.
 * 2. `firingFor` decide qué sale ya (`fired`) y qué espera a «marchar» (`held`).
 * 3. `stationTickets` agrupa por comanda lo que ve una estación en su pantalla.
 */
import { courseRank, isFoodCourse, type Course, type MenuItemEditable, type Station, type StationKind, type TaxRate } from "../carta/modelo"
import type { PricedLine } from "../carta/pedido"
import type { MenuText } from "../carta/textos"
import { menuLineStatus } from "../sala/estados"
import type { FireMode, FiringMode, FloorSettings, LineKind, LineStatus, OrderLine } from "../sala/modelo"
import { lineDelay, worstDelay, type Delay } from "./retrasos"

const MINUTO = 60_000

/* Borradores de línea ------------------------------------------------------------------------ */

export interface LineDraft {
  /** "3" para la línea 3 del pedido; "3.1", "3.2"… para los platos de un menú. */
  key: string
  parentKey: string | null
  kind: LineKind
  position: number
  itemId: string | null
  dailyMenuId: string | null
  sectionId: string | null
  version: number
  name: MenuText
  variant: { id: string; name: MenuText; priceCents: number } | null
  modifiers: { groupId: string; optionId: string; name: MenuText; priceCents: number }[]
  quantity: number
  unitPriceCents: number
  totalCents: number
  taxRate: TaxRate | null
  notes: string
  guest: number | null
  course: Course | null
  stationId: string | null
  stationKind: StationKind | null
  targetMinutes: number | null
}

type PlatoCocina = Pick<MenuItemEditable, "course" | "stationId" | "prepMinutes"> & { taxRate?: TaxRate }

/** Estación de un plato: la suya si existe y está activa; si no, la de por defecto; si no, ninguna. */
export function resolveStation(
  stationId: string | null,
  stations: Readonly<Record<string, Station | undefined>>,
  defaultStationId: string | null,
): { id: string; station: Station } | null {
  for (const id of [stationId, defaultStationId]) {
    if (id === null) continue
    const s = stations[id]
    if (s?.active) return { id, station: s }
  }
  return null
}

/**
 * Líneas calculadas → borradores con estación, pase y tiempo objetivo. `items` son los
 * documentos completos de los platos (la carta pública no tiene estación ni tiempos).
 * Un plato que ya no existe aquí no debería llegar (lo para `priceOrder`): se lanza un error.
 */
export function planOrderLines(
  priced: readonly PricedLine[],
  items: Readonly<Record<string, PlatoCocina | undefined>>,
  stations: Readonly<Record<string, Station | undefined>>,
  settings: Pick<FloorSettings, "defaultStationId" | "targets">,
  dailyMenus: Readonly<Record<string, { taxRate: TaxRate } | undefined>> = {},
): LineDraft[] {
  const drafts: LineDraft[] = []
  const cocina = (itemId: string, course: Course) => {
    const item = items[itemId]
    if (!item) throw new Error(`Falta el plato ${itemId} para mandarlo a cocina.`)
    const st = resolveStation(item.stationId, stations, settings.defaultStationId)
    return {
      course,
      stationId: st?.id ?? null,
      stationKind: st?.station.kind ?? null,
      targetMinutes: item.prepMinutes ?? st?.station.targetMinutes ?? settings.targets.defaultPrepMinutes,
    }
  }
  priced.forEach((l, i) => {
    const base = {
      dailyMenuId: l.dailyMenuId,
      version: l.version,
      name: l.name,
      quantity: l.quantity,
      notes: l.notes,
      guest: l.guest,
    }
    if (l.kind === "item") {
      const itemId = l.itemId as string
      const course = l.courseOverride ?? items[itemId]?.course ?? "second"
      drafts.push({
        ...base,
        key: String(i),
        parentKey: null,
        kind: "item",
        position: i * 100,
        itemId,
        sectionId: null,
        variant: l.variant,
        modifiers: l.modifiers,
        unitPriceCents: l.unitPriceCents,
        totalCents: l.totalCents,
        taxRate: items[itemId]?.taxRate ?? null,
        ...cocina(itemId, course),
      })
      return
    }
    // Menú: su línea lleva el precio del menú; cada plato, su suplemento y extras.
    const suplementos = l.components.reduce((s, c) => s + c.unitPriceCents, 0)
    const precioMenu = l.unitPriceCents - suplementos
    drafts.push({
      ...base,
      key: String(i),
      parentKey: null,
      kind: "menu",
      position: i * 100,
      itemId: null,
      sectionId: null,
      variant: null,
      modifiers: [],
      unitPriceCents: precioMenu,
      totalCents: precioMenu * l.quantity,
      taxRate: dailyMenus[l.dailyMenuId ?? ""]?.taxRate ?? null,
      course: null,
      stationId: null,
      stationKind: null,
      targetMinutes: null,
    })
    l.components.forEach((c, j) => {
      drafts.push({
        ...base,
        key: `${i}.${j + 1}`,
        parentKey: String(i),
        kind: "menu_component",
        position: i * 100 + j + 1,
        itemId: c.itemId,
        sectionId: c.sectionId,
        version: c.itemVersion,
        name: c.name,
        variant: c.variant,
        modifiers: c.modifiers,
        notes: c.notes,
        unitPriceCents: c.unitPriceCents,
        totalCents: c.unitPriceCents * l.quantity,
        taxRate: dailyMenus[l.dailyMenuId ?? ""]?.taxRate ?? null,
        ...cocina(c.itemId, c.course),
      })
    })
  })
  return drafts
}

/* Qué sale ya y qué espera ------------------------------------------------------------------ */

type LineaPase = Pick<OrderLine, "kind" | "course" | "status">
type NuevaLinea = Pick<LineDraft, "key" | "kind" | "course" | "parentKey">

const SIN_SERVIR: readonly LineStatus[] = ["pending", "held", "fired", "preparing", "ready"]

/**
 * Estado inicial (`fired` o `held`) de cada línea nueva de una mesa, con las que ya tiene.
 *
 * - Las bebidas salen siempre al momento.
 * - `fire: "all"` o el modo `all_at_once`: todo sale ya. `fire: "hold"`: todo espera (menos la bebida).
 * - `auto` por pases: un plato sale ya si no queda sin servir nada de un pase anterior (de
 *   antes o de este mismo pedido) y su pase no está ya esperando. Si no, espera a «marchar».
 *   Así, primeros y segundos pedidos juntos: los primeros salen y los segundos esperan; los
 *   segundos pedidos cuando los primeros ya están servidos, salen.
 *
 * Las líneas de menú (las que llevan el precio) toman el estado de sus platos.
 */
export function firingFor(
  newLines: readonly NuevaLinea[],
  existing: readonly LineaPase[],
  fire: FireMode,
  mode: FiringMode,
): Record<string, "fired" | "held"> {
  const r: Record<string, "fired" | "held"> = {}
  const reales = newLines.filter((l) => l.kind !== "menu")
  const comidaViva = [
    ...existing.filter((l) => l.kind !== "menu" && l.course !== null && isFoodCourse(l.course) && SIN_SERVIR.includes(l.status)).map((l) => ({ course: l.course as Course, held: l.status === "held" })),
    ...reales.filter((l) => l.course !== null && isFoodCourse(l.course)).map((l) => ({ course: l.course as Course, held: false })),
  ]
  for (const l of reales) {
    const course = l.course ?? "second"
    if (!isFoodCourse(course) || fire === "all" || (fire === "auto" && mode === "all_at_once")) r[l.key] = "fired"
    else if (fire === "hold") r[l.key] = "held"
    else {
      const antes = comidaViva.some((x) => courseRank(x.course) < courseRank(course))
      const esperando = existing.some((x) => x.kind !== "menu" && x.course === course && x.status === "held")
      r[l.key] = antes || esperando ? "held" : "fired"
    }
  }
  for (const l of newLines) {
    if (l.kind !== "menu") continue
    const hijos = newLines.filter((c) => c.parentKey === l.key).map((c) => ({ status: (r[c.key] ?? "held") as LineStatus }))
    r[l.key] = menuLineStatus(hijos) === "fired" ? "fired" : "held"
  }
  return r
}

/** Para llevar: cuándo se marcha sola una línea (recogida − antelación). */
export function takeawayFireAt(pickupAt: number, prepLeadMinutes: number): number {
  return pickupAt - prepLeadMinutes * MINUTO
}

/** Siguiente pase que espera a marchar en una mesa, o null. */
export function nextHeldCourse(lines: readonly LineaPase[]): Course | null {
  let mejor: Course | null = null
  for (const l of lines) {
    if (l.kind === "menu" || l.status !== "held" || l.course === null) continue
    if (mejor === null || courseRank(l.course) < courseRank(mejor)) mejor = l.course
  }
  return mejor
}

/**
 * Líneas que salen al «marchar»: las que esperan del pase pedido (o del siguiente si no se
 * dice ninguno). Con `course: "all"`, todas las que esperan (para llevar, o «marcha todo»).
 */
export function linesToFire<L extends LineaPase & { id: string }>(lines: readonly L[], course: Course | "all" | null): L[] {
  const pase = course === null ? nextHeldCourse(lines) : course
  if (pase === null) return []
  return lines.filter((l) => l.kind !== "menu" && l.status === "held" && (pase === "all" || l.course === pase))
}

/**
 * Con `autoFireNextCourse`: al servir, si ya no queda comida en marcha (marchada, en
 * preparación, lista o por aceptar), sale el siguiente pase que espera.
 */
export function autoFireAfterServe<L extends LineaPase & { id: string }>(lines: readonly L[], settings: Pick<FloorSettings, "firing">): L[] {
  if (!settings.firing.autoFireNextCourse) return []
  const enMarcha = lines.some(
    (l) => l.kind !== "menu" && l.course !== null && isFoodCourse(l.course) && ["pending", "fired", "preparing", "ready"].includes(l.status),
  )
  return enMarcha ? [] : linesToFire(lines, null)
}

/** Líneas de para llevar que ya tocan: esperando y con `fireAt` pasado. */
export function dueTakeawayLines<L extends Pick<OrderLine, "status" | "fireAt" | "kind">>(lines: readonly L[], now: number): L[] {
  return lines.filter((l) => l.kind !== "menu" && l.status === "held" && l.fireAt !== null && l.fireAt <= now)
}

/* Pantalla de una estación ---------------------------------------------------------------------- */

export type TicketLine = OrderLine & { id: string }

export interface CourseGroup<L> {
  course: Course
  lines: L[]
}

export interface StationTicket<L extends TicketLine = TicketLine> {
  orderId: string
  ticket?: OrderLine["ticket"]
  label: string
  sessionId: string | null
  takeawayId: string | null
  placedAt: number
  /** Primera hora de marcha de sus líneas, o null si todo espera. */
  firedAt: number | null
  /** Para llevar en espera: cuándo se marcha. */
  fireAt: number | null
  /** active: hay algo por hacer; ready: todo listo esperando a la sala; held: todo espera a marchar. */
  status: "active" | "ready" | "held"
  lines: L[]
  courses: CourseGroup<L>[]
  delay: Delay | null
}

const EN_PANTALLA: readonly LineStatus[] = ["held", "fired", "preparing", "ready"]

/** Agrupa líneas por pase, en el orden de los pases y, dentro, por posición. */
export function groupByCourse<L extends Pick<OrderLine, "course" | "position">>(lines: readonly L[]): CourseGroup<L>[] {
  const grupos = new Map<Course, L[]>()
  for (const l of [...lines].sort((a, b) => a.position - b.position)) {
    const c = l.course ?? "second"
    grupos.set(c, [...(grupos.get(c) ?? []), l])
  }
  return [...grupos.entries()].sort(([a], [b]) => courseRank(a) - courseRank(b)).map(([course, ls]) => ({ course, lines: ls }))
}

/**
 * Lo que ve una estación: una comanda por pedido con sus líneas de esa estación que estén
 * esperando, marchadas, en preparación o listas. Orden: primero lo que hay que hacer (por
 * hora de marcha), luego lo listo y al final lo que espera.
 */
export function stationTickets<L extends TicketLine>(lines: readonly L[], stationId: string, now: number, pickupMinutes: number): StationTicket<L>[] {
  const porComanda = new Map<string, L[]>()
  for (const l of lines) {
    if (l.stationId !== stationId || !EN_PANTALLA.includes(l.status)) continue
    // Al separar una mesa, una comanda puede tener líneas en dos destinos.
    const key = JSON.stringify([l.orderId, l.sessionId, l.takeawayId])
    porComanda.set(key, [...(porComanda.get(key) ?? []), l])
  }
  const tickets: StationTicket<L>[] = []
  for (const ls of porComanda.values()) {
    const ordenadas = [...ls].sort((a, b) => a.position - b.position)
    const primera = ordenadas[0] as L
    const marchas = ordenadas.map((l) => l.firedAt).filter((x): x is number => x !== null)
    const fireAts = ordenadas.map((l) => l.fireAt).filter((x): x is number => x !== null)
    const activa = ordenadas.some((l) => l.status === "fired" || l.status === "preparing")
    const lista = !activa && ordenadas.some((l) => l.status === "ready")
    tickets.push({
      orderId: primera.orderId,
      ...(primera.ticket ? { ticket: primera.ticket } : {}),
      label: primera.label,
      sessionId: primera.sessionId,
      takeawayId: primera.takeawayId,
      placedAt: Math.min(...ordenadas.map((l) => l.placedAt)),
      firedAt: marchas.length > 0 ? Math.min(...marchas) : null,
      fireAt: fireAts.length > 0 ? Math.min(...fireAts) : null,
      status: activa ? "active" : lista ? "ready" : "held",
      lines: ordenadas,
      courses: groupByCourse(ordenadas),
      delay: worstDelay(ordenadas.map((l) => lineDelay(l, now, pickupMinutes))),
    })
  }
  const peso = { active: 0, ready: 1, held: 2 } as const
  const hora = (t: StationTicket<L>) => (t.status === "held" ? (t.fireAt ?? t.placedAt) : (t.firedAt ?? t.placedAt))
  return tickets.sort((a, b) => peso[a.status] - peso[b.status] || hora(a) - hora(b))
}

/**
 * Agrupa las líneas listas de una mesa por estación, para crear o ampliar las tareas
 * «recoger en el pase». Solo cuentan las estaciones con `pickup: true`.
 */
export function readyForPickup<L extends Pick<OrderLine, "status" | "stationId" | "kind"> & { id: string }>(
  lines: readonly L[],
  stations: Readonly<Record<string, Pick<Station, "pickup"> | undefined>>,
): Record<string, string[]> {
  const r: Record<string, string[]> = {}
  for (const l of lines) {
    if (l.kind === "menu" || l.status !== "ready" || l.stationId === null) continue
    if (!stations[l.stationId]?.pickup) continue
    ;(r[l.stationId] ??= []).push(l.id)
  }
  return r
}

/**
 * Estado inicial de las líneas de un para llevar: todo espera hasta `fireAt` (recogida −
 * antelación) y sale solo a esa hora (programada `marcharParaLlevar`); si ya ha pasado, o
 * con `fire: "all"`, sale ya.
 */
export function takeawayFiring(
  newLines: readonly Pick<LineDraft, "key" | "kind">[],
  pickupAt: number,
  prepLeadMinutes: number,
  now: number,
  fire: FireMode = "auto",
): { fireAt: number; statuses: Record<string, "fired" | "held"> } {
  const fireAt = takeawayFireAt(pickupAt, prepLeadMinutes)
  const sale = fire === "all" || (fire === "auto" && now >= fireAt)
  const statuses: Record<string, "fired" | "held"> = {}
  for (const l of newLines) statuses[l.key] = sale ? "fired" : "held"
  return { fireAt, statuses }
}
