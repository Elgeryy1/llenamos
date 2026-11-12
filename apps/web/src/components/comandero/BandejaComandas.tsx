"use client"

import { can, LINE_STATUS_LABEL, ORDER_STATUS_LABEL, type OrderStatus } from "@llenamos/core"
import { useState } from "react"
import Link from "next/link"
import { usePanel } from "@/components/panel/PanelContext"
import { RequireModule } from "@/components/panel/RequireModule"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { PageHeading } from "@/components/common/page-heading"
import { Desplegable } from "@/components/common/desplegable"
import { DatePicker } from "@/components/common/date-picker"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/common/notice"
import { useComandas, useServicio, useAjustesSala, type Alcance } from "@/lib/comandero/datos"
import { llamarSala } from "@/lib/comandero/callables"
import { euros } from "@/lib/comandero/modelo"
import { localDate } from "@/lib/reservas/dia"
import { fechaToDate, dateToFecha, timeOf } from "@/lib/reservas/formato"
import { EnlacesServicio, EstadoLectura, useOperacion } from "./Servicio"

export function BandejaComandas() {
  const { location, restaurant } = usePanel()
  return <RequirePermission permission="comandas.tomar" what="las comandas"><RequireModule module="floor">{location ? <Bandeja key={`${restaurant.id}/${location.id}`} scope={{ restaurantId: restaurant.id, locationId: location.id }} /> : <Notice>Elige un local.</Notice>}</RequireModule></RequirePermission>
}
function Bandeja({ scope }: { scope: Alcance }) {
  const { restaurant, role } = usePanel()
  const orders = useComandas(scope), lines = useServicio(scope), settings = useAjustesSala(scope)
  const [day, setDay] = useState<string | null>(() => localDate(Date.now(), restaurant.timezone))
  const [channel, setChannel] = useState("all"), [status, setStatus] = useState("all"), [selected, setSelected] = useState<string | null>(null)
  const op = useOperacion()
  return <div className="space-y-5">
    <PageHeading title="Todas las comandas del local" description="Localiza pedidos por canal, estado y fecha, con sus platos y el destino actual." />
    <EnlacesServicio />
    {can(role, "sala.configurar") ? <section className="superficie space-y-3 p-4"><h2 className="font-semibold">Pedidos fuera de horario</h2><p className="text-sm text-muted-foreground">Para mesas abiertas, tanto desde el comandero como desde el QR. Se usan los turnos, excepciones y cierres de Horarios, hasta la última entrada del turno incluida.</p><EstadoLectura live={settings} label="la política horaria">{value => <label className="flex min-h-12 items-center gap-3"><input type="checkbox" checked={value.allowOrdersOutsideHours !== false} disabled={op.busy} onChange={e => { const allowed = e.target.checked; void op.run(async () => { await llamarSala("guardarConfiguracionSala", { ...scope, settings: { ...value, allowOrdersOutsideHours: allowed } }); return "Política horaria guardada." }) }} />Permitir pedir en mesas abiertas fuera de horario</label>}</EstadoLectura>{op.feedback}</section> : null}
    <div className="superficie flex flex-wrap items-end gap-3 p-4">
      <label className="text-sm">Fecha<DatePicker className="h-12" label="Fecha de las comandas" value={day ? fechaToDate(day) : undefined} onChange={d => setDay(dateToFecha(d))} onClear={() => setDay(null)} placeholder="Todas las fechas" /></label>
      <label className="text-sm">Canal<Desplegable className="min-h-12" value={channel} onChange={e => setChannel(e.target.value)}><option value="all">Todos los canales</option><option value="staff">Personal</option><option value="table">Mesa por QR</option><option value="takeaway_web">Web para llevar</option></Desplegable></label>
      <label className="text-sm">Estado<Desplegable className="min-h-12" value={status} onChange={e => setStatus(e.target.value)}><option value="all">Todos los estados</option>{Object.entries(ORDER_STATUS_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}<option value="ready">Con platos listos</option><option value="served">Todo servido</option><option value="cancelled">Todo anulado</option></Desplegable></label>
    </div>
    <EstadoLectura live={orders} label="las comandas">{data => {
      const rows = data.filter(o => {
        if (day && localDate(o.placedAt, restaurant.timezone) !== day) return false
        if (channel !== "all" && o.source !== channel) return false
        const own = lines.status === "ready" ? lines.data.filter(l => l.orderId === o.id && l.kind !== "menu") : []
        if (status === "ready") return own.some(l => l.status === "ready")
        if (status === "served" || status === "cancelled") return own.length > 0 && own.every(l => l.status === status)
        return status === "all" || o.status === status
      }).sort((a, b) => b.placedAt - a.placedAt)
      return <section className="superficie overflow-hidden"><h2 className="border-b p-4 font-semibold">{rows.length} comandas</h2><ul className="divide-y">{rows.map(o => <li key={o.id} className="space-y-3 p-4"><button className="flex min-h-12 w-full flex-wrap items-center justify-between gap-3 text-left" onClick={() => setSelected(selected === o.id ? null : o.id)} aria-expanded={selected === o.id}><span className="font-medium">{timeOf(o.placedAt, restaurant.timezone)} · {o.id.slice(-8)} · {({ staff: "Personal", table: "Mesa por QR", takeaway_web: "Web para llevar" })[o.source]}</span><span>{ORDER_STATUS_LABEL[o.status as OrderStatus]} · {euros(o.totalCents)}</span></button>{selected === o.id ? <><p className="text-sm">{o.note || "Sin nota de envío"}</p><EstadoLectura live={lines} label="los platos">{all => <ul className="space-y-2 text-sm">{all.filter(l => l.orderId === o.id).map(l => <li key={l.id}>{l.label} · {l.quantity} × {l.name.es}{l.variant ? ` · ${l.variant.name.es}` : ""}{l.modifiers.map(m => ` · ${m.name.es}`).join("")} · {LINE_STATUS_LABEL[l.status]}{l.notes ? ` · ${l.notes}` : ""}</li>)}</ul>}</EstadoLectura><Button asChild variant="outline" className="h-12"><Link href={o.sessionId ? `/panel/comandero?s=${encodeURIComponent(o.sessionId)}` : `/panel/para-llevar?t=${encodeURIComponent(o.takeawayId!)}`}>Abrir destino</Link></Button></> : null}</li>)}</ul>{!rows.length ? <p className="p-4 text-sm text-muted-foreground">No hay comandas con estos filtros.</p> : null}</section>
    }}</EstadoLectura>
  </div>
}
