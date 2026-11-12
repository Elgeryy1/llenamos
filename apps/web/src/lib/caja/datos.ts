"use client"

import { z } from "zod"
import {
  BillSchema,
  BillPartSchema,
  CashSessionSchema,
  CashMovementSchema,
  InvoiceSchema,
  PaymentSchema,
  PrintStatusSchema,
  PrinterSchema,
  MemberSchema,
  TableSessionSchema,
  TakeawaySchema,
  TipDistributionSchema,
} from "@llenamos/core"
import type { SalaServicioVivo } from "@llenamos/core"
import { useLiveQuery } from "@/lib/api/live"
import { useConsulta } from "./datos-demo"
import { donde, limite, ordenar } from "./restricciones"
import { useServicioVivo } from "@/lib/sala/vivo"
import { ruta, type ConId, type Lectura, type Scope } from "./datos-tipos"

export { ruta, type ConId, type Lectura, type Scope }

/**
 * Con `NEXT_PUBLIC_DATA_BACKEND=postgres` las lecturas salen de las LiveQuery de la API (`caja*`) y
 * no se toca Firestore; en la demo con emuladores siguen siendo suscripciones directas. El selector
 * se fija al compilar, así que en cada despliegue solo una de las dos ramas está activa.
 */
const vps = process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres"
const conId = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => schema.extend({ id: z.string() })
const Cuentas = z.object({ bills: z.array(conId(BillSchema)) })
const Cuenta = z.object({ bill: conId(BillSchema).nullable(), parts: z.array(conId(BillPartSchema)), payments: z.array(conId(PaymentSchema)) })
const Turnos = z.object({ sessions: z.array(conId(CashSessionSchema)) })
const Turno = z.object({ payments: z.array(conId(PaymentSchema)), movements: z.array(conId(CashMovementSchema)), distributions: z.array(conId(TipDistributionSchema)) })
const Historial = z.object({ payments: z.array(conId(PaymentSchema)), invoices: z.array(conId(InvoiceSchema)) })
const Impresion = z.object({ statuses: z.array(conId(PrintStatusSchema)) })
const Impresoras = z.object({ printers: z.array(conId(PrinterSchema)) })
const Equipo = z.object({ members: z.array(z.object({ id: z.string(), displayName: z.string() })) })
const Incidencias = z.object({ incidents: z.array(z.object({ id: z.string(), summary: z.string(), status: z.string() })) })

/** Adapta una lectura en vivo de la API al formato de listas del panel de caja. */
function useVps<D, T>(name: string, input: object | null, schema: z.ZodType<D>, pick: (data: D) => T[]): Lectura<T> {
  const live = useLiveQuery(name, vps ? input : null, schema)
  if (live.status === "ready") return { status: "ready", data: pick(live.data), fresh: true }
  return live
}
export function useCuentas(s: Scope) {
  const demo = useConsulta(vps ? null : `${ruta(s)}/bills`, BillSchema, [donde("status", "in", ["open", "locked"])])
  const live = useVps("cajaCuentas", s, Cuentas, d => d.bills)
  return vps ? live : demo
}
export function usePartes(s: Scope, id: string) {
  const demo = useConsulta(vps ? null : `${ruta(s)}/billParts`, BillPartSchema, [donde("billId", "==", id)], id)
  const live = useVps("cajaCuenta", { ...s, billId: id }, Cuenta, d => d.parts)
  return vps ? live : demo
}
// Mesas y recogidas abiertas: las publica sala (`salaServicio`), caja solo las lee para abrir cuentas.
const MESAS_ABIERTAS = ["open", "bill_requested"], RECOGIDAS_ABIERTAS = ["pending", "accepted", "ready"]
function useServicio<T>(s: Scope, pick: (servicio: SalaServicioVivo) => T[]): Lectura<T> {
  const live = useServicioVivo(vps ? s : null)
  if (live.status === "ready") return { status: "ready", data: pick(live.data), fresh: true }
  return live
}
export function useMesasCaja(s: Scope) {
  const demo = useConsulta(vps ? null : `${ruta(s)}/tableSessions`, TableSessionSchema, [donde("status", "in", MESAS_ABIERTAS)])
  const live = useServicio(s, d => d.sessions.filter(x => MESAS_ABIERTAS.includes(x.status)))
  return vps ? live : demo
}
export function useRecogidasCaja(s: Scope) {
  const demo = useConsulta(vps ? null : `${ruta(s)}/takeaways`, TakeawaySchema, [donde("status", "in", RECOGIDAS_ABIERTAS)])
  const live = useServicio(s, d => d.takeaways.filter(x => RECOGIDAS_ABIERTAS.includes(x.status)))
  return vps ? live : demo
}
export function useTurnos(s: Scope, allowed: boolean, count = 30) {
  const demo = useConsulta(!vps && allowed ? `${ruta(s)}/cashSessions` : null, CashSessionSchema, [ordenar("openedAt", "desc"), limite(count)], String(count))
  const live = useVps("cajaTurnos", allowed ? { ...s, limit: Math.min(count, 50) } : null, Turnos, d => d.sessions)
  return vps ? live : demo
}
export function usePagos(s: Scope, field: "billId" | "cashSessionId", id: string | null) {
  const demo = useConsulta(!vps && id ? `${ruta(s)}/payments` : null, PaymentSchema, [donde(field, "==", id)], `${field}:${id}`)
  const porCuenta = useVps("cajaCuenta", id && field === "billId" ? { ...s, billId: id } : null, Cuenta, d => d.payments)
  const porTurno = useVps("cajaTurno", id && field === "cashSessionId" ? { ...s, cashSessionId: id } : null, Turno, d => d.payments)
  return vps ? (field === "billId" ? porCuenta : porTurno) : demo
}
export function useMovimientos(s: Scope, id: string) {
  const demo = useConsulta(vps ? null : `${ruta(s)}/cashMovements`, CashMovementSchema, [donde("cashSessionId", "==", id)], id)
  const live = useVps("cajaTurno", { ...s, cashSessionId: id }, Turno, d => d.movements)
  return vps ? live : demo
}
export function useFacturas(s: Scope, count: number) {
  const demo = useConsulta(vps ? null : `${ruta(s)}/invoices`, InvoiceSchema, [ordenar("createdAt", "desc"), limite(count)], String(count))
  const live = useVps("cajaHistorial", { ...s, limit: Math.min(count, 100) }, Historial, d => d.invoices)
  return vps ? live : demo
}
export function useImpresiones(s: Scope, sourceId: string) {
  const demo = useConsulta(vps ? null : `${ruta(s)}/printStatuses`, PrintStatusSchema, [donde("sourceId", "==", sourceId)], sourceId)
  const live = useVps("cajaImpresion", { ...s, sourceId, limit: 20 }, Impresion, d => d.statuses)
  return vps ? live : demo
}
export function useImpresoras(s: Scope, allowed: boolean) {
  const demo = useConsulta(!vps && allowed ? `${ruta(s)}/printers` : null, PrinterSchema, [donde("active", "==", true)])
  const live = useVps("cajaImpresoras", allowed ? s : null, Impresoras, d => d.printers.filter(p => p.active))
  return vps ? live : demo
}
// Los miembros los gestiona la plataforma; caja solo lee los del local para repartir propinas (`cajaEquipo`).
export type MiembroCaja = { id: string; displayName: string }
export function useEquipoCaja(s: Scope, allowed: boolean): Lectura<MiembroCaja> {
  const demo = useConsulta(!vps && allowed ? `restaurants/${s.restaurantId}/members` : null, MemberSchema, [donde("active", "==", true)])
  const live = useVps("cajaEquipo", allowed ? s : null, Equipo, d => d.members)
  if (!vps) return demo.status === "ready" ? { ...demo, data: demo.data.map(m => ({ id: m.id, displayName: m.displayName })) } : demo
  return allowed ? live : { status: "ready", data: [], fresh: true }
}
export function useRepartos(s: Scope, id: string) {
  const demo = useConsulta(vps ? null : `${ruta(s)}/tipDistributions`, TipDistributionSchema, [donde("cashSessionId", "==", id)], id)
  const live = useVps("cajaTurno", { ...s, cashSessionId: id }, Turno, d => d.distributions)
  return vps ? live : demo
}
export function useCuenta(s: Scope, id: string | null) {
  const demo = useConsulta(!vps && id ? `${ruta(s)}/bills` : null, BillSchema, [donde("__name__", "==", id)], String(id))
  const live = useVps("cajaCuenta", id ? { ...s, billId: id } : null, Cuenta, d => (d.bill ? [d.bill] : []))
  return vps ? live : demo
}
export function useHistorialPagos(s: Scope, count: number) {
  const demo = useConsulta(vps ? null : `${ruta(s)}/payments`, PaymentSchema, [ordenar("at", "desc"), limite(count)], String(count))
  const live = useVps("cajaHistorial", { ...s, limit: Math.min(count, 100) }, Historial, d => d.payments)
  return vps ? live : demo
}
// Cobros móviles con Stripe que no cuadran con la caja y necesitan a una persona (`cajaIncidencias`).
export function useIncidenciasMoviles(s: Scope, allowed: boolean) {
  const demo = useConsulta(!vps && allowed ? `${ruta(s)}/mobileIncidents` : null,
    z.object({ summary: z.string(), status: z.string() }), [donde("status", "==", "open"), limite(30)])
  const live = useVps("cajaIncidencias", allowed ? s : null, Incidencias, d => d.incidents)
  return vps ? live : demo
}
