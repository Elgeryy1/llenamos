"use client"

/**
 * Lecturas en directo de personal. Los fichajes y turnos se leen con el esquema del contrato;
 * un documento que no lo cumple es un error visible, nunca un dato a medias. Las consultas llevan
 * los filtros que piden las reglas (el camarero solo lee sus fichajes y los turnos publicados).
 *
 * Con `NEXT_PUBLIC_DATA_BACKEND=postgres` se leen de la API del VPS (`useLiveQuery` por nombre) y no
 * se toca Firestore: la escucha de Firestore se deja con clave nula. Sin él, sigue la demo con emuladores.
 */
import {
  PERSONAL_LIVE,
  PersonalAbiertosOutputSchema,
  PersonalAjustesOutputSchema,
  PersonalEventosOutputSchema,
  PersonalFichajesOutputSchema,
  PersonalTurnosOutputSchema,
  StaffSettingsSchema,
  StaffShiftSchema,
  TimeEntryEventSchema,
  TimeEntrySchema,
  defaultStaffSettings,
  type CallableOutput,
  type StaffSettings,
  type StaffShiftWithId,
  type TimeEntryEvent,
  type TimeEntryWithId,
} from "@llenamos/core"
import { useEffect, useState } from "react"
import { z } from "zod"
import { DataShapeError } from "@/lib/data/parse"
import { useLiveQuery as useLiveApi } from "@/lib/api/live"
import { useLiveDoc, useLiveQuery, type Live } from "@/lib/fase4/demo"
import { mapLive, modoVps, useEntrada } from "@/lib/fase4/vivo"
import { errorPersonal, llamarPersonal, type Alcance } from "./api"

export type HoursRowOutput = CallableOutput<"informeHoras">["rows"][number]

export const rutaLocal = (s: Alcance) => `restaurants/${s.restaurantId}/locations/${s.locationId}`

function leer<S extends z.ZodType>(schema: S, path: string, data: unknown): z.output<S> {
  const r = schema.safeParse(data)
  if (!r.success) throw new DataShapeError(path, r.error.issues.map((i) => i.path.join(".")))
  return r.data
}

/** Ajustes de personal. Solo los lee quien gestiona; el resto no los necesita. */
export function useAjustesPersonal(scope: Alcance | null, enabled: boolean): Live<StaffSettings> {
  const vps = modoVps()
  const path = !vps && scope && enabled ? `${rutaLocal(scope)}/settings/staff` : null
  const demo = useLiveDoc(path, (id, data) => (data === undefined ? defaultStaffSettings() : leer(StaffSettingsSchema, `${path}`, data)))
  const entrada = useEntrada(vps && enabled, scope ? { restaurantId: scope.restaurantId, locationId: scope.locationId } : null)
  const api = useLiveApi(PERSONAL_LIVE.ajustes, entrada, PersonalAjustesOutputSchema)
  return vps ? mapLive(api, (r) => r.settings) : demo
}

/** Los fichajes de una persona en un periodo (por fecha de entrada). */
export function useFichajesDe(scope: Alcance | null, uid: string, from: string, to: string): Live<TimeEntryWithId[]> {
  const vps = modoVps()
  const base = !vps && scope ? `${rutaLocal(scope)}/timeEntries` : null
  const demo = useLiveQuery(
    base ? `mis:${base}:${uid}:${from}:${to}` : null,
    (db, fs) => fs.query(fs.collection(db, base!), fs.where("uid", "==", uid), fs.where("date", ">=", from), fs.where("date", "<=", to), fs.orderBy("date", "desc")),
    (id, data) => ({ ...leer(TimeEntrySchema, `${base}/${id}`, data), id }),
  )
  const entrada = useEntrada(vps, scope ? { restaurantId: scope.restaurantId, locationId: scope.locationId, from, to, uid } : null)
  const api = useLiveApi(PERSONAL_LIVE.fichajes, entrada, PersonalFichajesOutputSchema)
  // La API incluye el día anterior por los fichajes que cruzan la medianoche: aquí se vuelve al periodo pedido, como la consulta de la demo.
  return vps ? mapLive(api, (r) => (r.entries as TimeEntryWithId[]).filter((e) => e.date >= from && e.date <= to).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))) : demo
}

/** Los fichajes de todos en un periodo (solo para quien gestiona). Incluye el día anterior por si cruza la medianoche. */
export function useFichajesPeriodo(scope: Alcance | null, from: string, to: string): Live<TimeEntryWithId[]> {
  const vps = modoVps()
  const base = !vps && scope ? `${rutaLocal(scope)}/timeEntries` : null
  const demo = useLiveQuery(
    base ? `periodo:${base}:${from}:${to}` : null,
    (db, fs) => fs.query(fs.collection(db, base!), fs.where("date", ">=", from), fs.where("date", "<=", to), fs.orderBy("date"), fs.orderBy("startAt")),
    (id, data) => ({ ...leer(TimeEntrySchema, `${base}/${id}`, data), id }),
  )
  const entrada = useEntrada(vps, scope ? { restaurantId: scope.restaurantId, locationId: scope.locationId, from, to, uid: null } : null)
  const api = useLiveApi(PERSONAL_LIVE.fichajes, entrada, PersonalFichajesOutputSchema)
  return vps ? mapLive(api, (r) => r.entries as TimeEntryWithId[]) : demo
}

/** Quién tiene el fichaje abierto ahora (solo para quien gestiona). */
export function useFichajesAbiertos(scope: Alcance | null): Live<TimeEntryWithId[]> {
  const vps = modoVps()
  const base = !vps && scope ? `${rutaLocal(scope)}/timeEntries` : null
  const demo = useLiveQuery(
    base ? `abiertos:${base}` : null,
    (db, fs) => fs.query(fs.collection(db, base!), fs.where("status", "==", "open")),
    (id, data) => ({ ...leer(TimeEntrySchema, `${base}/${id}`, data), id }),
  )
  const entrada = useEntrada(vps, scope ? { restaurantId: scope.restaurantId, locationId: scope.locationId } : null)
  const api = useLiveApi(PERSONAL_LIVE.abiertos, entrada, PersonalAbiertosOutputSchema)
  return vps ? mapLive(api, (r) => r.entries as TimeEntryWithId[]) : demo
}

/** Turnos de una semana. `soloPublicados` es obligatorio para quien no gestiona. */
export function useTurnosSemana(scope: Alcance | null, weekStart: string, soloPublicados: boolean): Live<StaffShiftWithId[]> {
  const vps = modoVps()
  const base = !vps && scope ? `${rutaLocal(scope)}/shifts` : null
  const demo = useLiveQuery(
    base ? `turnos:${base}:${weekStart}:${soloPublicados}` : null,
    (db, fs) =>
      soloPublicados
        ? fs.query(fs.collection(db, base!), fs.where("status", "==", "published"), fs.where("weekStart", "==", weekStart), fs.orderBy("startAt"))
        : fs.query(fs.collection(db, base!), fs.where("weekStart", "==", weekStart), fs.orderBy("startAt")),
    (id, data) => ({ ...leer(StaffShiftSchema, `${base}/${id}`, data), id }),
  )
  const entrada = useEntrada(vps, scope ? { restaurantId: scope.restaurantId, locationId: scope.locationId, weekStart, onlyPublished: soloPublicados } : null)
  const api = useLiveApi(PERSONAL_LIVE.turnos, entrada, PersonalTurnosOutputSchema)
  return vps ? mapLive(api, (r) => r.shifts as StaffShiftWithId[]) : demo
}

/** Historial de un fichaje (auditoría). Solo para quien gestiona. */
export function useEventosFichaje(scope: Alcance | null, entryId: string | null): Live<(TimeEntryEvent & { id: string })[]> {
  const vps = modoVps()
  const base = !vps && scope ? `${rutaLocal(scope)}/timeEntryEvents` : null
  const demo = useLiveQuery(
    base && entryId ? `eventos:${base}:${entryId}` : null,
    (db, fs) => fs.query(fs.collection(db, base!), fs.where("entryId", "==", entryId)),
    (id, data) => ({ ...leer(TimeEntryEventSchema, `${base}/${id}`, data), id }),
  )
  const entrada = useEntrada(vps && entryId !== null, scope && entryId ? { restaurantId: scope.restaurantId, locationId: scope.locationId, entryId } : null)
  const api = useLiveApi(PERSONAL_LIVE.eventos, entrada, PersonalEventosOutputSchema)
  const live = vps ? mapLive(api, (r) => r.events as (TimeEntryEvent & { id: string })[]) : demo
  if (live.status !== "ready") return live
  return { status: "ready", data: [...live.data].sort((a, b) => a.at - b.at) }
}

/**
 * Informe de horas del servidor (`informeHoras`). No es una escucha en directo: se vuelve a pedir
 * cuando cambia el periodo o la persona, o cuando `recarga` cambia (después de guardar algo).
 * Con `uid` null trae a todos (solo encargados).
 */
export function useInformeHoras(scope: Alcance | null, from: string, to: string, uid: string | null, recarga: number): { status: "loading" } | { status: "error"; message: string } | { status: "ready"; rows: HoursRowOutput[] } {
  const clave = scope ? `${scope.restaurantId}:${scope.locationId}:${from}:${to}:${uid ?? "todos"}:${recarga}` : null
  const [estado, setEstado] = useState<{ clave: string; valor: { status: "error"; message: string } | { status: "ready"; rows: HoursRowOutput[] } } | null>(null)
  useEffect(() => {
    if (!scope || !clave) return
    let vivo = true
    llamarPersonal("informeHoras", { ...scope, from, to, uid })
      .then((r) => vivo && setEstado({ clave, valor: { status: "ready", rows: r.rows } }))
      .catch((error: unknown) => vivo && setEstado({ clave, valor: { status: "error", message: errorPersonal(error) } }))
    return () => { vivo = false }
  }, [clave, scope, from, to, uid])
  return estado?.clave === clave ? estado.valor : { status: "loading" }
}

export type HorasPropinas = CallableOutput<"horasParaPropinas">

/**
 * Horas fichadas dentro de una caja cerrada (`horasParaPropinas`), para precargar el reparto de
 * propinas. Se pide una vez por caja; `enabled` apaga la llamada cuando el restaurante no tiene
 * el módulo de personal, y entonces no se hace ninguna petición.
 */
export function useHorasParaPropinas(
  scope: Alcance | null,
  cashSessionId: string,
  enabled: boolean,
): { status: "off" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: HorasPropinas } {
  const clave = scope && enabled ? `${scope.restaurantId}:${scope.locationId}:${cashSessionId}` : null
  const [estado, setEstado] = useState<{ clave: string; valor: { status: "error"; message: string } | { status: "ready"; data: HorasPropinas } } | null>(null)
  useEffect(() => {
    if (!scope || !clave) return
    let vivo = true
    llamarPersonal("horasParaPropinas", { ...scope, cashSessionId })
      .then((data) => vivo && setEstado({ clave, valor: { status: "ready", data } }))
      .catch((error: unknown) => vivo && setEstado({ clave, valor: { status: "error", message: errorPersonal(error) } }))
    return () => { vivo = false }
  }, [clave, scope, cashSessionId])
  if (!clave) return { status: "off" }
  return estado?.clave === clave ? estado.valor : { status: "loading" }
}
