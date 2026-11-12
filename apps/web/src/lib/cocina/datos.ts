"use client"

import { FloorSettingsSchema, MenuItemSchema, OrderLineSchema, StationSchema, defaultFloorSettings, type StationKind } from "@llenamos/core"
import { z } from "zod"
import { useEffect, useState } from "react"
import type { Live } from "@/lib/api/live"
import type { TicketLine } from "@llenamos/core"
import { DataShapeError } from "@/lib/data/parse"
import { useDemoDoc, useDemoQuery } from "@/lib/sala/demo"
import { alcanceDe, useDerivado, enVps, useCartaVivaVps, useLineasEstacionVps } from "@/lib/sala/vivo"
import { cargarClienteDemo, cargarCocinaDemo, cargarFirestore } from "@/lib/firebase/cargar-demo"

export function leerDocumento<S extends z.ZodType>(schema: S, path: string, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data)
  if (!parsed.success) throw new DataShapeError(path, parsed.error.issues.map((i) => i.path.join(".")))
  return parsed.data
}

function useDatosEstacionesFs(base: string | null) {
  const stations = useDemoQuery(base ? `${base}/stations` : null, [],
    (id, data) => ({ ...leerDocumento(StationSchema, `${base}/stations/${id}`, data), id }))
  const settings = useDemoDoc(base ? `${base}/settings/floor` : null,
    (id, data) => data === undefined ? defaultFloorSettings() : leerDocumento(FloorSettingsSchema, `${base}/settings/${id}`, data))
  return { stations, settings }
}

function useLineasEstacionFs(base: string | null, stationId: string | null, kind: StationKind, revision: number): Live<TicketLine[]> & { cached?: boolean } {
  const key = JSON.stringify([base, stationId, kind, revision])
  const [state, setState] = useState<{ key: string; live: Live<TicketLine[]> & { cached?: boolean } } | null>(null)
  useEffect(() => {
    if (!base || !stationId) return
    let activo = true, parar = () => {}
    // Firestore solo se descarga en la demo: nunca se importa de forma estática.
    void Promise.all([cargarFirestore(), cargarCocinaDemo(), cargarClienteDemo()]).then(([{ onSnapshot }, { consultaLineas }, { getFirebase }]) => {
      if (!activo) return
      parar = onSnapshot(consultaLineas(getFirebase().db, base, stationId, kind), { includeMetadataChanges: true }, (snapshot) => {
        try {
          const data = snapshot.docs.map((d) => ({ ...leerDocumento(OrderLineSchema, `${base}/orderLines/${d.id}`, d.data()), id: d.id }))
          setState({ key, live: { status: "ready", data, cached: snapshot.metadata.fromCache } })
        } catch (error) {
          setState({ key, live: { status: "error", error } })
        }
      }, (error) => setState({ key, live: { status: "error", error } }))
    }).catch((error) => { if (activo) setState({ key, live: { status: "error", error } }) })
    return () => { activo = false; parar() }
  }, [key, base, stationId, kind])
  return state?.key === key ? state.live : { status: "loading" }
}

function usePlatosEstacionFs(base: string | null) {
  return useDemoQuery(base ? `${base}/menuItems` : null, [],
    (id, data) => ({ ...leerDocumento(MenuItemSchema, `${base}/menuItems/${id}`, data), id }))
}

function useDatosEstacionesVps(base: string | null) {
  const live = useCartaVivaVps(alcanceDe(base))
  return {
    stations: useDerivado(live, v => v.stations as (z.output<typeof StationSchema> & { id: string })[]),
    settings: useDerivado(live, v => v.settings),
  }
}
function useLineasEstacionVpsLive(base: string | null, stationId: string | null, kind: StationKind): Live<TicketLine[]> & { cached?: boolean } {
  return useDerivado(useLineasEstacionVps(alcanceDe(base), stationId, kind), v => v.lines as TicketLine[]) as Live<TicketLine[]>
}
function usePlatosEstacionVps(base: string | null) {
  return useDerivado(useCartaVivaVps(base ? alcanceDe(base) : null), v => v.items as (z.output<typeof MenuItemSchema> & { id: string })[])
}
export const useDatosEstaciones = enVps ? useDatosEstacionesVps : useDatosEstacionesFs
export const useLineasEstacion = enVps ? useLineasEstacionVpsLive : useLineasEstacionFs
export const usePlatosEstacion = enVps ? usePlatosEstacionVps : usePlatosEstacionFs
