"use client"

/** Ganchos de datos del panel, encima de las suscripciones en directo. */
import { useMemo } from "react"
import { z } from "zod"
import { AreaSchema, MemberSchema, TableSchema } from "@llenamos/core"
import type { Live } from "@/lib/api/live"
import { ApiCallError } from "@/lib/api/transport"
import { isVpsBackend, mapLive, useVpsLive } from "./backend"
import { useDemoQuery } from "./demo-live"
import { parseActivity, parseArea, parseMemberStrict, parseTable, type ActivityDoc, type AreaDoc, type MemberDoc, type TableDoc } from "./parse"

const PlanoSchema = z.object({ areas: z.array(AreaSchema.extend({ id: z.string() })), tables: z.array(TableSchema.extend({ id: z.string() })) })

export interface SalaData {
  areas: AreaDoc[]
  tables: TableDoc[]
}

/** Une dos estados en directo: listo cuando lo están los dos, error si falla cualquiera. */
export function combineLive<A, B, C>(a: Live<A>, b: Live<B>, join: (a: A, b: B) => C): Live<C> {
  if (a.status === "error") return a
  if (b.status === "error") return b
  if (a.status === "loading" || b.status === "loading") return { status: "loading" }
  return { status: "ready", data: join(a.data, b.data) }
}

/** Zonas y mesas de un local, en directo. */
export function useSala(restaurantId: string, locationId: string | null): Live<SalaData> {
  const base = locationId ? `restaurants/${restaurantId}/locations/${locationId}` : null
  const vps = isVpsBackend()
  const areas = useDemoQuery(!vps && base ? { path: `${base}/areas` } : null, parseArea)
  const tables = useDemoQuery(!vps && base ? { path: `${base}/tables` } : null, parseTable)
  const api = useVpsLive("plano", locationId ? { restaurantId, locationId } : null, PlanoSchema)
  const fromApi = useMemo(() => mapLive(api, (a): SalaData => ({ areas: a.areas as AreaDoc[], tables: a.tables as TableDoc[] })), [api])
  if (!base) return { status: "ready", data: { areas: [], tables: [] } }
  if (vps) return fromApi
  return combineLive(areas, tables, (a, t) => ({ areas: a, tables: t }))
}

/** Personas del equipo, en directo. En el VPS es la lectura `miembros` (cualquier miembro activo del restaurante). */
export function useMembers(restaurantId: string, enabled = true): Live<MemberDoc[]> {
  const vps = isVpsBackend()
  const demo = useDemoQuery(!vps && enabled ? { path: `restaurants/${restaurantId}/members` } : null, parseMemberStrict)
  const api = useVpsLive("miembros", enabled ? { restaurantId } : null, z.array(MemberSchema))
  return vps ? api : demo
}

const ACTIVITY_NOT_IN_VPS = new ApiCallError("not-deployed", "El registro de actividad todavía no está disponible en el servidor propio.")

/**
 * Últimas entradas del registro de actividad, en directo. El VPS aún no guarda un registro general de actividad
 * (cada módulo tiene el suyo): responde «no disponible» y la pantalla lo dice, en vez de enseñar una lista vacía.
 */
export function useActivity(restaurantId: string, max: number, enabled = true): Live<ActivityDoc[]> {
  const vps = isVpsBackend()
  const demo = useDemoQuery(
    !vps && enabled ? { path: `restaurants/${restaurantId}/activity`, orderBy: ["createdAt", "desc"], limit: max } : null,
    parseActivity,
  )
  if (!vps) return demo
  return enabled ? { status: "error", error: ACTIVITY_NOT_IN_VPS } : { status: "loading" }
}
