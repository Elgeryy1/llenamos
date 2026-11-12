"use client"

import { useState } from "react"
import { can, hasModule, horaLocal, previousRange, sumarDias, type CallableInput } from "@llenamos/core"
import { DownloadSimpleIcon } from "@phosphor-icons/react"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import { DateInput } from "@/components/common/date-picker"
import { SelectField } from "@/components/common/form-fields"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Notice } from "@/components/common/notice"
import { useNow } from "@/lib/use-now"
import { useAccion, useConsulta } from "@/lib/analisis/datos"
import { panelEjemplo } from "@/lib/analisis/fixtures"
import { cambio, descargarCsv, euros, METRICAS, porcentaje, type PanelDatos } from "@/lib/analisis/presentacion"
import { Bloque, EstadoAccion, Grafica, Resultado } from "./piezas"

export function Ventas({ ejemplo }: { ejemplo: boolean }) {
  const { restaurant, location, locations, role } = usePanel()
  const hoy = horaLocal(useNow(60_000).getTime(), restaurant.timezone).fecha
  const [from, setFrom] = useState(sumarDias(hoy, -6)), [to, setTo] = useState(hoy)
  const [local, setLocal] = useState(location?.id ?? "todos")
  const [compare, setCompare] = useState<"previous" | "none">("previous")
  const [slotMinutes, setSlot] = useState<15 | 30 | 60>(60)
  const [kind, setKind] = useState<CallableInput<"exportarAnalisis">["kind"]>("sales_by_day")
  const accion = useAccion()
  const input = { restaurantId: restaurant.id, from, to, locationIds: local === "todos" ? null : [local], compare, slotMinutes }
  const valid = from <= to && sumarDias(from, 365) >= to
  const consulta = useConsulta("panelAnalisis", ejemplo || !valid ? null : input)
  const exportable = valid && sumarDias(from, 91) >= to
  const margen = can(role, "costes.ver") && hasModule(restaurant, "inventory")
  const nombres = new Map(locations.map((l) => [l.id, l.name]))
  const base = previousRange(from, to)
  const fixture = ejemplo && valid ? panelEjemplo(from, to, local === "todos" ? locations.map((l) => l.id) : [local], slotMinutes) : null
  return <div className="space-y-5">
    <div className="superficie grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <DateInput label="Desde" value={from} clearable={false} onChange={(v) => v && setFrom(v)} />
      <DateInput label="Hasta" value={to} clearable={false} min={from} onChange={(v) => v && setTo(v)} />
      <SelectField label="Locales" value={local} onChange={(e) => setLocal(e.target.value)}><option value="todos">Todos mis locales</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</SelectField>
      <SelectField label="Comparación" value={compare} onChange={(e) => setCompare(e.target.value as typeof compare)}><option value="previous">Periodo anterior</option><option value="none">Sin comparación</option></SelectField>
      <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">{compare === "previous" ? `Comparado con el ${base.from} al ${base.to}, de la misma duración.` : "Comparación desactivada."} Fechas del local, {restaurant.timezone}.</p>
      <Button variant="outline" onClick={consulta.recargar} disabled={ejemplo}>Actualizar</Button>
    </div>
    {!valid ? <Notice tone="error">Elige fechas en orden y un periodo de como mucho 366 días.</Notice> : fixture ? <Datos datos={{ ...fixture, comparison: compare === "none" ? null : fixture.comparison }} margen={margen} ventas={hasModule(restaurant, "pos")} nombres={nombres} compare={compare} slot={slotMinutes} onSlot={setSlot} /> : <Resultado live={consulta.live}>{(datos) => <Datos datos={datos} margen={margen} ventas={hasModule(restaurant, "pos")} nombres={nombres} compare={compare} slot={slotMinutes} onSlot={setSlot} />}</Resultado>}
    <Bloque title="Llévate las cifras" description="CSV para Excel, sin contactos. Como mucho 92 días por descarga.">
      <div className="flex flex-wrap items-end gap-3"><SelectField label="Qué exportar" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="sales_by_day">Ventas por día</option><option value="dishes">Platos</option><option value="hours">Horas</option><option value="locations">Locales</option>{hasModule(restaurant, "marketing") ? <option value="origins">Origen de reservas</option> : null}</SelectField><Button disabled={ejemplo || !exportable || accion.pending} variant="outline" onClick={async () => { const result = await accion.run("exportarAnalisis", { restaurantId: restaurant.id, from, to, locationIds: input.locationIds, kind }, "CSV preparado por el servidor."); if (result) descargarCsv(result) }}><DownloadSimpleIcon aria-hidden />Descargar CSV</Button></div>
      {!exportable ? <p className="mt-3 text-sm text-warning">Reduce el periodo a 92 días para exportar.</p> : null}
    </Bloque><EstadoAccion accion={accion} />
  </div>
}

export function Datos({ datos, margen, ventas, nombres, compare, slot, onSlot }: { datos: PanelDatos; margen: boolean; ventas: boolean; nombres: Map<string, string>; compare: "previous" | "none"; slot: 15 | 30 | 60; onSlot: (v: 15 | 30 | 60) => void }) {
  const [platos, setPlatos] = useState("top")
  const filas = platos === "zero" ? datos.dishes.zeroSales.map((d) => ({ ...d, units: null, unitsInMenu: null, salesCents: null })) : platos === "bottom" ? datos.dishes.bottom : datos.dishes.top
  return <div className="space-y-5">
    {!ventas ? <Notice>El módulo Caja no está activo. No hay ventas disponibles; las reservas siguen disponibles.</Notice> : null}
    <SummaryStrip label="Cifras del periodo" items={["grossSalesCents", "guests", "occupancyBp", "noShowBp"].map((key) => { const m = METRICAS.find((m) => m.key === key)!; return { label: m.label, value: <span className="text-2xl sm:text-3xl xl:text-4xl">{m.format(datos.total[m.key])}</span>, hint: compare === "none" ? undefined : cambio(datos.comparison?.[key]) } })} />
    <Bloque title="Cada día cuenta" description="Ventas brutas de cuentas cobradas. Las cuentas abiertas y las propinas quedan fuera.">
      <Grafica label="Ventas brutas por día" money rows={datos.byDay.map((d) => ({ label: d.date.slice(5).split("-").reverse().join("/"), value: d.metrics.grossSalesCents }))} />
      <details className="mt-4 text-sm"><summary className="cursor-pointer py-2">Ver cifras por día</summary><div className="divide-y">{datos.byDay.map((d) => <div key={d.date} className="flex flex-wrap justify-between gap-2 py-3"><span>{d.date}</span><span className="cifra">{euros(d.metrics.grossSalesCents)} · {d.metrics.guests} comensales · {porcentaje(d.metrics.occupancyBp)}</span></div>)}</div></details>
    </Bloque>
    <div className="grid gap-5 lg:grid-cols-2">
      <Bloque title="La sala en números" description={`${datos.total.noShows} reservas no presentadas, ${datos.total.noShowCovers} comensales perdidos.`}><dl className="divide-y">{METRICAS.filter((m) => !["grossSalesCents", "guests", "occupancyBp", "noShowBp"].includes(m.key)).map((m) => <div key={m.key} className="flex justify-between gap-3 py-3 text-sm"><dt>{m.label}</dt><dd className="cifra text-right">{m.format(datos.total[m.key])}{compare === "previous" ? <small className="mt-1 block font-sans text-xs text-muted-foreground">{cambio(datos.comparison?.[m.key])}</small> : null}</dd></div>)}</dl></Bloque>
      <Bloque title={datos.hours.peak ? `La hora punta: ${datos.hours.peak}` : "Horas punta"} description="Mesas por hora de apertura. Reservas por hora de llegada."><SelectField label="Duración del tramo" value={slot} onChange={(e) => onSlot(Number(e.target.value) as 15 | 30 | 60)}>{[15, 30, 60].map((v) => <option key={v} value={v}>{v} minutos</option>)}</SelectField><Grafica label="Comensales por hora de apertura de mesa" rows={datos.hours.slots.map((s) => ({ label: s.slot, value: s.guests }))} /><details className="mt-3 text-sm"><summary className="cursor-pointer py-2">Ver todos los tramos</summary>{datos.hours.slots.map((s) => <p key={s.slot} className="border-b py-3">{s.slot}: {s.guests} comensales, {s.bills} cuentas, {euros(s.salesCents)}. {s.reservations} reservas, {s.reservationCovers} comensales reservados.</p>)}</details></Bloque>
    </div>
    <Bloque title="Cómo va cada local" description="Solo los locales a los que tienes acceso. La ocupación se calcula con las plazas y los horarios de cada uno."><div className="divide-y">{datos.byLocation.map((l) => <div key={l.locationId} className="grid gap-2 py-3 text-sm sm:grid-cols-4"><strong>{nombres.get(l.locationId) ?? l.locationId}</strong><span className="cifra">{euros(l.metrics.grossSalesCents)}</span><span>{porcentaje(l.salesShareBp)} de las ventas</span><span>Ocupación {porcentaje(l.metrics.occupancyBp)}</span></div>)}</div></Bloque>
    <Bloque title="Los platos del periodo" description="Unidades sueltas y dentro del menú por separado. Un plato de menú no suma ingresos propios."><SelectField label="Qué platos ver" value={platos} onChange={(e) => setPlatos(e.target.value)}><option value="top">Más vendidos</option><option value="bottom">Menos vendidos</option><option value="zero">Sin ventas</option></SelectField><div className="mt-3 divide-y">{filas.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No hay platos en esta selección.</p> : filas.map((d) => <div key={d.itemId} className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm"><span className="font-medium">{d.name}</span>{d.units !== null ? <span className="cifra text-muted-foreground">{d.units} sueltas · {d.unitsInMenu} en menú · {euros(d.salesCents)}</span> : <span className="text-muted-foreground">Sin ventas en la carta activa</span>}</div>)}</div></Bloque>
    {margen ? <Bloque title="El margen de lo vendido" description="Coste histórico congelado de la fase 4. Excluye los platos de menú y no prorratea descuentos.">{datos.margin ? <dl className="grid gap-4 sm:grid-cols-3">{[["Margen", euros(datos.margin.marginCents)], ["Margen porcentual", porcentaje(datos.margin.marginBp)], ["Unidades con coste", porcentaje(datos.margin.coverageBp)], ["Ingreso neto cubierto", euros(datos.margin.coveredNetCents)], ["Coste", euros(datos.margin.costCents)], ["Coste de merma", euros(datos.margin.wasteCostCents)]].map(([k, v]) => <div key={k}><dt className="text-xs text-muted-foreground">{k}</dt><dd className="cifra mt-2 text-xl">{v}</dd></div>)}</dl> : <p className="text-sm text-muted-foreground">No hay margen disponible para este periodo.</p>}</Bloque> : null}
    <Bloque title="Qué significa cada cifra"><dl className="space-y-3">{METRICAS.map((m) => <div key={m.key} className="text-sm"><dt className="font-medium">{m.label}</dt><dd className="mt-1 text-muted-foreground">{m.definition}</dd></div>)}</dl><p className="mt-4 text-xs text-muted-foreground">Calculado hasta {new Date(datos.computedAt).toLocaleString("es", { timeZone: "Europe/Madrid" })}. Sin denominador o sin base anterior se muestra «Sin datos» o «Sin base anterior».</p></Bloque>
  </div>
}
