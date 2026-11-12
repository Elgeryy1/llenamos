"use client"
import { z } from "zod"
import { PrinterSchema, PrintStatusSchema, StationSchema } from "@llenamos/core"
import { useLiveQuery } from "@/lib/api/live"
import type { Live } from "@/lib/api/live"
import { useConsulta } from "@/lib/caja/datos-demo"
import type { Lectura } from "@/lib/caja/datos-tipos"
import { limite, ordenar } from "@/lib/caja/restricciones"
import { useCartaVivaVps } from "@/lib/sala/vivo"

const vps = process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres"
const Estados = z.object({ statuses: z.array(PrintStatusSchema.extend({ id: z.string() })) })
const Impresoras = z.object({ printers: z.array(PrinterSchema.extend({ id: z.string() })) })
const deLectura = <T,>(lectura: Lectura<T>): Live<T[]> => (lectura.status === "ready" ? { status: "ready", data: lectura.data } : lectura)
const parte = <D, T>(live: Live<D>, pick: (d: D) => T): Live<T> => (live.status === "ready" ? { status: "ready", data: pick(live.data) } : live)
/**
 * Impresoras, estaciones de cocina y estado de los trabajos. Con `NEXT_PUBLIC_DATA_BACKEND=postgres` salen de las
 * lecturas en vivo de la API (impresoras y estados de caja, estaciones de la carta de sala); sin él, de la demo con
 * emuladores, que carga Firestore solo en ese caso.
 */
export function useImpresion(restaurantId: string, locationId: string) {
  const path = `restaurants/${restaurantId}/locations/${locationId}`
  const demoPrinters = useConsulta(vps ? null : `${path}/printers`, PrinterSchema)
  const demoStations = useConsulta(vps ? null : `${path}/stations`, StationSchema)
  const demoJobs = useConsulta(vps ? null : `${path}/printStatuses`, PrintStatusSchema, [ordenar("updatedAt", "desc"), limite(40)])
  const scope = { restaurantId, locationId }
  const livePrinters = useLiveQuery("cajaImpresoras", vps ? scope : null, Impresoras)
  const liveJobs = useLiveQuery("cajaImpresion", vps ? { ...scope, sourceId: null, limit: 40 } : null, Estados)
  const liveCard = useCartaVivaVps(vps ? scope : null)
  if (!vps) return { printers: deLectura(demoPrinters), stations: deLectura(demoStations), jobs: deLectura(demoJobs) }
  return { printers: parte(livePrinters, d => d.printers), stations: parte(liveCard, d => d.stations), jobs: parte(liveJobs, d => d.statuses) }
}
export const estadoImpresion = {
  queued: "En cola",
  leased: "En manos del puente",
  printed: "Envío confirmado por el puente",
  failed: "Falló antes de enviar",
  uncertain: "Resultado incierto",
  cancelled: "Cancelado",
  not_configured: "Sin configurar",
} as const
