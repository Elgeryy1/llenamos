/**
 * Modelo del editor del plano: zonas y mesas de un local como un borrador que se
 * edita en el navegador y se guarda de una vez.
 *
 * Todo es puro (sin Firebase ni React): cada operación recibe el borrador y
 * devuelve otro nuevo. Las posiciones van en la rejilla 0–100 del contrato
 * (porcentaje del ancho y del alto de la zona). Las uniones (`joinableWith`) se
 * mantienen simétricas y solo dentro de la misma zona.
 */
import { AreaSchema, TableSchema, type Area, type Table } from "@llenamos/core"

export type EditorTable = Table & { id: string }
export type EditorArea = Area & { id: string }

export interface PlanoDraft {
  areas: EditorArea[]
  tables: EditorTable[]
}

/** Paso de la rejilla al arrastrar y con las flechas. */
export const GRID_STEP = 1
export const MIN_SIZE = 4
export const MAX_SEATS = 30
export const DEFAULT_SIZE = { rect: { w: 12, h: 14 }, round: { w: 10, h: 16 } } as const

/* Utilidades -------------------------------------------------------------- */

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

/** Redondea a la rejilla (y a dos decimales, para no guardar 33.333333). */
export function snap(n: number, step = GRID_STEP): number {
  return Math.round(Math.round(n / step) * step * 100) / 100
}

function byName(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name, "es", { numeric: true })
}

export function sortedAreas(draft: PlanoDraft): EditorArea[] {
  return [...draft.areas].sort((a, b) => a.sortOrder - b.sortOrder || byName(a, b))
}

export function tablesOf(draft: PlanoDraft, areaId: string): EditorTable[] {
  return draft.tables.filter((t) => t.areaId === areaId).sort(byName)
}

function replaceTable(draft: PlanoDraft, id: string, patch: (t: EditorTable) => EditorTable): PlanoDraft {
  return { ...draft, tables: draft.tables.map((t) => (t.id === id ? patch(t) : t)) }
}

/** Mete la caja dentro del plano sin cambiar su tamaño (si cabe). */
export function fitBox(box: { x: number; y: number; w: number; h: number }) {
  const w = clamp(snap(box.w), MIN_SIZE, 100)
  const h = clamp(snap(box.h), MIN_SIZE, 100)
  return { w, h, x: clamp(snap(box.x), 0, 100 - w), y: clamp(snap(box.y), 0, 100 - h) }
}

/* Mesas -------------------------------------------------------------------- */

/** Mueve una mesa a (x, y), dentro del plano y en la rejilla. */
export function moveTable(draft: PlanoDraft, id: string, x: number, y: number): PlanoDraft {
  return replaceTable(draft, id, (t) => ({ ...t, ...fitBox({ x, y, w: t.w, h: t.h }) }))
}

/** Desplaza una mesa (las flechas del teclado). */
export function nudgeTable(draft: PlanoDraft, id: string, dx: number, dy: number): PlanoDraft {
  const t = draft.tables.find((m) => m.id === id)
  if (!t) return draft
  return moveTable(draft, id, t.x + dx, t.y + dy)
}

/** Cambia el tamaño desde la esquina de abajo a la derecha: la esquina de arriba no se mueve. */
export function resizeTable(draft: PlanoDraft, id: string, w: number, h: number): PlanoDraft {
  return replaceTable(draft, id, (t) => ({
    ...t,
    w: clamp(snap(w), MIN_SIZE, 100 - t.x),
    h: clamp(snap(h), MIN_SIZE, 100 - t.y),
  }))
}

export function toggleShape(draft: PlanoDraft, id: string): PlanoDraft {
  return replaceTable(draft, id, (t) => ({ ...t, shape: t.shape === "round" ? "rect" : "round" }))
}

export function setEnabled(draft: PlanoDraft, id: string, enabled: boolean): PlanoDraft {
  return replaceTable(draft, id, (t) => ({ ...t, enabled }))
}

export function setSeats(draft: PlanoDraft, id: string, seats: number): PlanoDraft {
  if (!Number.isFinite(seats)) return draft
  return replaceTable(draft, id, (t) => ({ ...t, seats: clamp(Math.round(seats), 1, MAX_SEATS) }))
}

export function renameTable(draft: PlanoDraft, id: string, name: string): PlanoDraft {
  return replaceTable(draft, id, (t) => ({ ...t, name: name.slice(0, 20) }))
}

/** Prefijo para los nombres de mesa de una zona: «Sala» → «S», «Terraza» → «T». */
export function namePrefix(areaName: string): string {
  const letter = areaName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .charAt(0)
    .toUpperCase()
  return /[A-Z]/.test(letter) ? letter : "M"
}

/** Primer nombre libre en todo el local: S1, S2… (los nombres no se repiten entre zonas). */
export function nextTableName(draft: PlanoDraft, areaId: string): string {
  const area = draft.areas.find((a) => a.id === areaId)
  const prefix = namePrefix(area?.name ?? "")
  const taken = new Set(draft.tables.map((t) => t.name.trim().toLowerCase()))
  for (let n = 1; ; n++) {
    const name = `${prefix}${n}`
    if (!taken.has(name.toLowerCase())) return name
  }
}

/** Primer hueco libre del plano para una caja de w×h, recorriendo de arriba abajo. */
export function freeSpot(draft: PlanoDraft, areaId: string, w: number, h: number): { x: number; y: number } {
  const others = tablesOf(draft, areaId)
  for (let y = 2; y <= 100 - h; y += 2) {
    for (let x = 2; x <= 100 - w; x += 2) {
      const box = { x, y, w, h }
      // Se deja un margen de 2 alrededor para que no queden pegadas.
      if (others.every((o) => !boxesOverlap({ x: x - 2, y: y - 2, w: w + 4, h: h + 4 }, o))) return box
    }
  }
  return { x: 0, y: 0 }
}

/** Mesa nueva de 4 plazas en el primer hueco libre de la zona. */
export function addTable(draft: PlanoDraft, areaId: string, id: string, shape: "rect" | "round" = "rect"): PlanoDraft {
  const { w, h } = DEFAULT_SIZE[shape]
  const spot = freeSpot(draft, areaId, w, h)
  const table: EditorTable = {
    id,
    name: nextTableName(draft, areaId),
    areaId,
    seats: 4,
    shape,
    ...spot,
    w,
    h,
    joinableWith: [],
    enabled: true,
  }
  return { ...draft, tables: [...draft.tables, table] }
}

/** Borra una mesa y la quita de las uniones de las demás. */
export function deleteTable(draft: PlanoDraft, id: string): PlanoDraft {
  return {
    ...draft,
    tables: draft.tables
      .filter((t) => t.id !== id)
      .map((t) => (t.joinableWith.includes(id) ? { ...t, joinableWith: t.joinableWith.filter((j) => j !== id) } : t)),
  }
}

/** Cambia una mesa de zona: pierde sus uniones (solo se unen mesas de la misma zona). */
export function moveTableToArea(draft: PlanoDraft, id: string, areaId: string): PlanoDraft {
  const t = draft.tables.find((m) => m.id === id)
  if (!t || t.areaId === areaId) return draft
  const unlinked = deleteLinks(draft, id)
  const moved = replaceTable(unlinked, id, (m) => ({ ...m, areaId }))
  const target = moved.tables.find((m) => m.id === id)!
  const spot = freeSpot({ ...moved, tables: moved.tables.filter((m) => m.id !== id) }, areaId, target.w, target.h)
  return moveTable(moved, id, spot.x, spot.y)
}

function deleteLinks(draft: PlanoDraft, id: string): PlanoDraft {
  return {
    ...draft,
    tables: draft.tables.map((t) => {
      if (t.id === id) return { ...t, joinableWith: [] }
      if (t.joinableWith.includes(id)) return { ...t, joinableWith: t.joinableWith.filter((j) => j !== id) }
      return t
    }),
  }
}

/* Uniones ------------------------------------------------------------------ */

export function canJoin(draft: PlanoDraft, a: string, b: string): boolean {
  if (a === b) return false
  const ta = draft.tables.find((t) => t.id === a)
  const tb = draft.tables.find((t) => t.id === b)
  return Boolean(ta && tb && ta.areaId === tb.areaId)
}

/** Marca o desmarca que dos mesas se pueden juntar, en los dos sentidos a la vez. */
export function setJoinable(draft: PlanoDraft, a: string, b: string, joinable: boolean): PlanoDraft {
  if (joinable && !canJoin(draft, a, b)) return draft
  const link = (t: EditorTable, other: string): EditorTable => {
    const has = t.joinableWith.includes(other)
    if (joinable && !has) return { ...t, joinableWith: [...t.joinableWith, other].sort() }
    if (!joinable && has) return { ...t, joinableWith: t.joinableWith.filter((j) => j !== other) }
    return t
  }
  return {
    ...draft,
    tables: draft.tables.map((t) => (t.id === a ? link(t, b) : t.id === b ? link(t, a) : t)),
  }
}

/**
 * Arregla uniones que no cuadran en datos antiguos: si A dice B y B no dice A, se
 * completa; si apunta a una mesa que no existe o de otra zona, se quita.
 */
export function normalizeJoins(draft: PlanoDraft): PlanoDraft {
  const byId = new Map(draft.tables.map((t) => [t.id, t]))
  const pairs = new Set<string>()
  for (const t of draft.tables) {
    for (const j of t.joinableWith) {
      const other = byId.get(j)
      if (!other || other.id === t.id || other.areaId !== t.areaId) continue
      pairs.add([t.id, j].sort().join("\u0000"))
    }
  }
  const links = new Map<string, Set<string>>()
  for (const p of pairs) {
    const [a, b] = p.split("\u0000") as [string, string]
    if (!links.has(a)) links.set(a, new Set())
    if (!links.has(b)) links.set(b, new Set())
    links.get(a)!.add(b)
    links.get(b)!.add(a)
  }
  return {
    ...draft,
    tables: draft.tables.map((t) => {
      const next = [...(links.get(t.id) ?? [])].sort()
      return sameList(next, [...t.joinableWith].sort()) ? t : { ...t, joinableWith: next }
    }),
  }
}

/* Zonas -------------------------------------------------------------------- */

export function addArea(draft: PlanoDraft, id: string, name: string): PlanoDraft {
  const maxOrder = draft.areas.reduce((m, a) => Math.max(m, a.sortOrder), -1)
  return { ...draft, areas: [...draft.areas, { id, name: name.slice(0, 40), sortOrder: maxOrder + 1 }] }
}

export function renameArea(draft: PlanoDraft, id: string, name: string): PlanoDraft {
  return { ...draft, areas: draft.areas.map((a) => (a.id === id ? { ...a, name: name.slice(0, 40) } : a)) }
}

/** Sube (-1) o baja (+1) una zona en el orden. Deja los sortOrder seguidos desde 0. */
export function moveArea(draft: PlanoDraft, id: string, direction: -1 | 1): PlanoDraft {
  const list = sortedAreas(draft)
  const i = list.findIndex((a) => a.id === id)
  const j = i + direction
  if (i < 0 || j < 0 || j >= list.length) return draft
  ;[list[i], list[j]] = [list[j]!, list[i]!]
  const order = new Map(list.map((a, index) => [a.id, index]))
  return { ...draft, areas: draft.areas.map((a) => ({ ...a, sortOrder: order.get(a.id) ?? a.sortOrder })) }
}

/** Una zona solo se borra vacía, para no perder mesas sin querer. */
export function canDeleteArea(draft: PlanoDraft, id: string): boolean {
  return !draft.tables.some((t) => t.areaId === id)
}

export function deleteArea(draft: PlanoDraft, id: string): PlanoDraft {
  if (!canDeleteArea(draft, id)) return draft
  return { ...draft, areas: draft.areas.filter((a) => a.id !== id) }
}

/* Validación --------------------------------------------------------------- */

export function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
}

export interface PlanoProblem {
  /** Mesa o zona a la que se refiere (para marcarla). */
  id: string
  kind: "table" | "area"
  message: string
}

/** Lo que impide guardar: nombres vacíos o repetidos, mesas que se pisan, datos fuera del contrato. */
export function validateDraft(draft: PlanoDraft): PlanoProblem[] {
  const problems: PlanoProblem[] = []
  const areaIds = new Set(draft.areas.map((a) => a.id))

  const areaNames = new Map<string, string>()
  for (const a of sortedAreas(draft)) {
    const r = AreaSchema.safeParse(a)
    if (!r.success) {
      problems.push({ id: a.id, kind: "area", message: a.name.trim() ? `La zona «${a.name}» no es válida.` : "Hay una zona sin nombre." })
      continue
    }
    const key = a.name.trim().toLowerCase()
    const prev = areaNames.get(key)
    if (prev) problems.push({ id: a.id, kind: "area", message: `Hay dos zonas que se llaman «${a.name.trim()}».` })
    else areaNames.set(key, a.id)
  }

  const tableNames = new Map<string, string>()
  const tables = [...draft.tables].sort(byName)
  for (const t of tables) {
    const label = t.name.trim() || "sin nombre"
    if (!t.name.trim()) {
      problems.push({ id: t.id, kind: "table", message: "Hay una mesa sin nombre." })
    } else {
      const key = t.name.trim().toLowerCase()
      if (tableNames.has(key)) problems.push({ id: t.id, kind: "table", message: `Hay dos mesas que se llaman «${label}».` })
      else tableNames.set(key, t.id)
    }
    if (!areaIds.has(t.areaId)) problems.push({ id: t.id, kind: "table", message: `La mesa ${label} está en una zona que no existe.` })
    const data = tableData(t)
    if (t.name.trim() && !TableSchema.safeParse(data).success) {
      problems.push({ id: t.id, kind: "table", message: `La mesa ${label} tiene datos fuera de rango.` })
    }
    if (t.x + t.w > 100.001 || t.y + t.h > 100.001) {
      problems.push({ id: t.id, kind: "table", message: `La mesa ${label} se sale del plano.` })
    }
  }

  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = tables[i]!
      const b = tables[j]!
      if (a.areaId === b.areaId && boxesOverlap(a, b)) {
        problems.push({ id: b.id, kind: "table", message: `Las mesas ${a.name} y ${b.name} se pisan.` })
      }
    }
  }
  return problems
}

/* Guardar: qué documentos cambian --------------------------------------------- */

export type TableData = Table
export type AreaData = Area

export interface PlanoChanges {
  createAreas: Array<{ id: string; data: AreaData }>
  updateAreas: Array<{ id: string; data: Partial<AreaData> }>
  deleteAreas: string[]
  createTables: Array<{ id: string; data: TableData }>
  updateTables: Array<{ id: string; data: Partial<TableData> }>
  deleteTables: string[]
}

function sameList(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function sameValue(a: unknown, b: unknown) {
  if (Array.isArray(a) && Array.isArray(b)) return sameList([...a].sort(), [...b].sort())
  return a === b
}

const TABLE_FIELDS = ["name", "areaId", "seats", "shape", "x", "y", "w", "h", "joinableWith", "enabled"] as const
const AREA_FIELDS = ["name", "sortOrder"] as const

function tableData(t: EditorTable): TableData {
  return {
    name: t.name.trim(),
    areaId: t.areaId,
    seats: t.seats,
    shape: t.shape,
    x: t.x,
    y: t.y,
    w: t.w,
    h: t.h,
    joinableWith: [...t.joinableWith],
    enabled: t.enabled,
  }
}

function areaData(a: EditorArea): AreaData {
  return { name: a.name.trim(), sortOrder: a.sortOrder }
}

function changedFields<T extends object, K extends keyof T>(before: T, after: T, keys: readonly K[]): Partial<T> {
  const out: Partial<T> = {}
  for (const k of keys) if (!sameValue(before[k], after[k])) out[k] = after[k]
  return out
}

/**
 * Diferencias entre lo guardado y el borrador, campo a campo. Solo se escribe lo
 * que ha cambiado, así dos personas que tocan mesas distintas no se pisan.
 */
export function diffDraft(saved: PlanoDraft, draft: PlanoDraft): PlanoChanges {
  const savedAreas = new Map(saved.areas.map((a) => [a.id, a]))
  const savedTables = new Map(saved.tables.map((t) => [t.id, t]))
  const draftAreas = new Set(draft.areas.map((a) => a.id))
  const draftTables = new Set(draft.tables.map((t) => t.id))
  const changes: PlanoChanges = {
    createAreas: [],
    updateAreas: [],
    deleteAreas: saved.areas.filter((a) => !draftAreas.has(a.id)).map((a) => a.id),
    createTables: [],
    updateTables: [],
    deleteTables: saved.tables.filter((t) => !draftTables.has(t.id)).map((t) => t.id),
  }
  for (const a of draft.areas) {
    const before = savedAreas.get(a.id)
    if (!before) changes.createAreas.push({ id: a.id, data: areaData(a) })
    else {
      const data = changedFields(areaData(before), areaData(a), AREA_FIELDS)
      if (Object.keys(data).length > 0) changes.updateAreas.push({ id: a.id, data })
    }
  }
  for (const t of draft.tables) {
    const before = savedTables.get(t.id)
    if (!before) changes.createTables.push({ id: t.id, data: tableData(t) })
    else {
      const data = changedFields(tableData(before), tableData(t), TABLE_FIELDS)
      if (Object.keys(data).length > 0) changes.updateTables.push({ id: t.id, data })
    }
  }
  return changes
}

export function countChanges(c: PlanoChanges): number {
  return (
    c.createAreas.length +
    c.updateAreas.length +
    c.deleteAreas.length +
    c.createTables.length +
    c.updateTables.length +
    c.deleteTables.length
  )
}

/** Un lote de Firestore admite 500 escrituras. */
export const MAX_WRITES = 500

/* Arrastrar: de píxeles a la rejilla ----------------------------------------- */

/** Convierte un desplazamiento en píxeles a puntos de la rejilla 0–100 del plano. */
export function pixelsToGrid(dx: number, dy: number, width: number, height: number): { dx: number; dy: number } {
  if (width <= 0 || height <= 0) return { dx: 0, dy: 0 }
  return { dx: (dx / width) * 100, dy: (dy / height) * 100 }
}

/** Texto de una mesa para lectores de pantalla y para el título. */
export function describeEditorTable(t: EditorTable, names: ReadonlyMap<string, string>): string {
  const parts = [
    `Mesa ${t.name || "sin nombre"}`,
    `${t.seats} ${t.seats === 1 ? "plaza" : "plazas"}`,
    t.shape === "round" ? "redonda" : "rectangular",
    `posición ${Math.round(t.x)}, ${Math.round(t.y)}`,
  ]
  if (!t.enabled) parts.push("deshabilitada")
  const joinable = t.joinableWith.map((id) => names.get(id)).filter((n): n is string => Boolean(n))
  if (joinable.length > 0) parts.push(`se puede juntar con ${joinable.join(", ")}`)
  return parts.join(", ")
}
