/**
 * Cálculos del plano de sala. Las mesas guardan su sitio en una rejilla de 0 a 100
 * (porcentaje del ancho y del alto de su zona), así que el plano se adapta a
 * cualquier pantalla.
 */
import type { AreaDoc, TableDoc } from "@/lib/data/parse"

export interface AreaPlan {
  /** null = mesas cuya zona no existe (datos incompletos). */
  area: AreaDoc | null
  tables: TableDoc[]
  stats: TableStats
}

export interface TableStats {
  tables: number
  enabled: number
  /** Plazas de las mesas habilitadas. */
  seats: number
}

export function tableStats(tables: readonly TableDoc[]): TableStats {
  const enabled = tables.filter((t) => t.enabled)
  return {
    tables: tables.length,
    enabled: enabled.length,
    seats: enabled.reduce((sum, t) => sum + t.seats, 0),
  }
}

function byName(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name, "es", { numeric: true })
}

/** Agrupa las mesas por zona, en el orden de sortOrder. Las mesas huérfanas van al final. */
export function planByArea(areas: readonly AreaDoc[], tables: readonly TableDoc[]): AreaPlan[] {
  const sortedAreas = [...areas].sort((a, b) => a.sortOrder - b.sortOrder || byName(a, b))
  const known = new Set(sortedAreas.map((a) => a.id))
  const plans: AreaPlan[] = sortedAreas.map((area) => {
    const own = tables.filter((t) => t.areaId === area.id).sort(byName)
    return { area, tables: own, stats: tableStats(own) }
  })
  const orphans = tables.filter((t) => !known.has(t.areaId)).sort(byName)
  if (orphans.length > 0) plans.push({ area: null, tables: orphans, stats: tableStats(orphans) })
  return plans
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

/** Posición en CSS. Si una mesa se sale del plano, se mete dentro en vez de cortarla. */
export function tableBox(t: Pick<TableDoc, "x" | "y" | "w" | "h">) {
  const w = clamp(t.w, 2, 100)
  const h = clamp(t.h, 2, 100)
  const x = clamp(t.x, 0, 100 - w)
  const y = clamp(t.y, 0, 100 - h)
  return { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }
}

/** Parejas de mesas que se pisan en el plano (sirve para avisar de datos mal puestos). */
export function overlappingTables(tables: readonly TableDoc[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = tables[i]!
      const b = tables[j]!
      if (a.areaId !== b.areaId) continue
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
      if (!apart) out.push([a.id, b.id])
    }
  }
  return out
}

/** Texto para lectores de pantalla: «Mesa S4, 4 plazas, redonda, se puede juntar con S5». */
export function describeTable(t: TableDoc, names: ReadonlyMap<string, string>): string {
  const parts = [`Mesa ${t.name}`, `${t.seats} ${t.seats === 1 ? "plaza" : "plazas"}`, t.shape === "round" ? "redonda" : "rectangular"]
  if (!t.enabled) parts.push("deshabilitada")
  const joinable = t.joinableWith.map((id) => names.get(id)).filter((n): n is string => Boolean(n))
  if (joinable.length > 0) parts.push(`se puede juntar con ${joinable.join(", ")}`)
  return parts.join(", ")
}
