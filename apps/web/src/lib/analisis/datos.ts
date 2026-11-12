"use client"

import { useEffect, useRef, useState } from "react"
import { AnalyticsSettingsSchema, AutomationRuleInputSchema, RecommendationSchema, type CallableInput, type CallableOutput } from "@llenamos/core"
import { z } from "zod"
import { useLiveQuery as useLiveApi, type Live } from "@/lib/api/live"
import { useLiveDoc, useLiveQuery } from "@/lib/fase4/demo"
import { modoVps, useEntrada } from "@/lib/fase4/vivo"
import { llamarAnalisis, type NombreAnalisis } from "./api"

/** La clave incluye el alcance: nunca enseña una respuesta de otro restaurante o filtro. */
export function useConsulta<N extends NombreAnalisis>(name: N, input: CallableInput<N> | null) {
  const serialized = input === null ? null : JSON.stringify(input)
  const [version, setVersion] = useState(0)
  const key = `${name}:${serialized}:${version}`
  const [state, setState] = useState<{ key: string; live: Live<CallableOutput<N>> } | null>(null)
  useEffect(() => {
    if (serialized === null) return
    let alive = true
    llamarAnalisis(name, JSON.parse(serialized) as CallableInput<N>).then(
      (data) => { if (alive) setState({ key, live: { status: "ready", data } }) },
      (error: unknown) => { if (alive) setState({ key, live: { status: "error", error } }) },
    )
    return () => { alive = false }
  }, [name, serialized, key])
  const live: Live<CallableOutput<N>> = state?.key === key ? state.live : { status: "loading" }
  return { live, recargar: () => setVersion((v) => v + 1) }
}

/** Conserva el requestId al reintentar la misma entrada tras una respuesta incierta. */
export function useAccion() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [message, setMessage] = useState("")
  const active = useRef(false)
  const requests = useRef(new Map<string, string>())
  async function run<N extends NombreAnalisis>(name: N, input: Omit<CallableInput<N>, "requestId">, success: string): Promise<CallableOutput<N> | undefined> {
    if (active.current) return
    active.current = true
    setPending(true); setError(null); setMessage("")
    const key = JSON.stringify([name, input])
    const requestId = requests.current.get(key) ?? crypto.randomUUID()
    requests.current.set(key, requestId)
    try {
      const mutacion = ["guardarConfiguracionAnalisis", "guardarAutomatizacion", "borrarAutomatizacion", "resolverRecomendacion"].includes(name)
      const result = await llamarAnalisis(name, (mutacion ? { ...input, requestId } : input) as CallableInput<N>)
      requests.current.delete(key)
      setMessage(success)
      return result
    } catch (e) { setError(e) }
    finally { active.current = false; setPending(false) }
  }
  return { run, pending, error, message, clear: () => { setError(null); setMessage("") } }
}

export const ReglaGuardadaSchema = z.object({ id: z.string(), revision: z.number().int().min(1), rule: AutomationRuleInputSchema })
const RecomendacionGuardadaSchema = RecommendationSchema.extend({ id: z.string() })
const AjustesVivoSchema = AnalyticsSettingsSchema.nullable()
const ReglasVivoSchema = z.array(ReglaGuardadaSchema)
const RecomendacionesVivoSchema = z.array(RecomendacionGuardadaSchema)

/** Con `NEXT_PUBLIC_DATA_BACKEND=postgres` salen de las lecturas `analisis.*` de la API y Firestore no se escucha. */
export function useAjustes(restaurantId: string | null) {
  const vps = modoVps()
  const demo = useLiveDoc(!vps && restaurantId ? `restaurants/${restaurantId}/settings/analytics` : null, (_id, data) => data === undefined ? null : AnalyticsSettingsSchema.parse({ dailySummary: data.dailySummary, forecast: data.forecast, lapsedAfterDays: data.lapsedAfterDays }))
  const api = useLiveApi("analisis.ajustes", useEntrada(vps, restaurantId ? { restaurantId } : null), AjustesVivoSchema)
  return vps ? api : demo
}
export function useReglas(restaurantId: string | null) {
  const vps = modoVps()
  const demo = useLiveQuery(!vps && restaurantId ? `reglas:${restaurantId}` : null,
    (db, fs) => fs.query(fs.collection(db, `restaurants/${restaurantId}/automationRules`), fs.orderBy("name"), fs.limit(100)),
    (id, data) => ReglaGuardadaSchema.parse({ id, revision: data.revision, rule: Object.fromEntries(Object.keys(AutomationRuleInputSchema.shape).map((key) => [key, data[key]])) }),
  )
  const api = useLiveApi("analisis.reglas", useEntrada(vps, restaurantId ? { restaurantId } : null), ReglasVivoSchema)
  return vps ? api : demo
}
export function useRecomendaciones(restaurantId: string | null) {
  const vps = modoVps()
  const demo = useLiveQuery(!vps && restaurantId ? `recomendaciones:${restaurantId}` : null,
    (db, fs) => fs.query(fs.collection(db, `restaurants/${restaurantId}/recommendations`), fs.orderBy("createdAt", "desc"), fs.limit(100)),
    (id, data) => ({ id, ...RecommendationSchema.parse(data) }),
  )
  const api = useLiveApi("analisis.recomendaciones", useEntrada(vps, restaurantId ? { restaurantId } : null), RecomendacionesVivoSchema)
  return vps ? api : demo
}

const UltimoResumenSchema = z.object({ date: z.string() }).nullable()
/**
 * Fecha del último resumen guardado. En el VPS la da la lectura `analisis.ultimoResumen` (una consulta); la demo no la tiene
 * y sigue probando fechas con `buscarUltimoResumen`. Es global: quien tiene locales limitados recibe null.
 */
export function useUltimoResumen(restaurantId: string | null) {
  const vps = modoVps()
  const api = useLiveApi("analisis.ultimoResumen", useEntrada(vps, restaurantId ? { restaurantId } : null), UltimoResumenSchema)
  return { vps, api }
}
