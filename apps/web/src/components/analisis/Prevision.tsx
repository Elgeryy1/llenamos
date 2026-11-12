"use client"

import { useState } from "react"
import { FORECAST_CONFIDENCE_LABEL, horaLocal, type CallableOutput } from "@llenamos/core"
import { usePanel } from "@/components/panel/PanelContext"
import { DateInput } from "@/components/common/date-picker"
import { SelectField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { useNow } from "@/lib/use-now"
import { accesoAnalisis } from "@/lib/analisis/api"
import { useConsulta } from "@/lib/analisis/datos"
import { previsionEjemplo } from "@/lib/analisis/fixtures"
import { porcentaje } from "@/lib/analisis/presentacion"
import { Bloque, Grafica, Resultado } from "./piezas"

export function Prevision({ ejemplo }: { ejemplo: boolean }) {
  const { restaurant, role, location, locations } = usePanel()
  const hoy = horaLocal(useNow(60_000).getTime(), restaurant.timezone).fecha
  const [from, setFrom] = useState(hoy), [days, setDays] = useState(7), [local, setLocal] = useState(location?.id ?? locations[0]?.id ?? "")
  const allowed = accesoAnalisis("previsionOcupacion", role, restaurant)
  const consulta = useConsulta("previsionOcupacion", ejemplo || !allowed || !local ? null : { restaurantId: restaurant.id, locationId: local, from, days })
  if (!allowed) return <Notice>La previsión necesita el módulo Reservas además de Análisis.</Notice>
  if (!local) return <Notice>Necesitas un local para consultar su previsión.</Notice>
  return <div className="space-y-5"><div className="superficie grid gap-4 p-4 sm:grid-cols-3"><DateInput label="A partir del" clearable={false} value={from} onChange={(v) => v && setFrom(v)} /><SelectField label="Días previstos" value={days} onChange={(e) => setDays(Number(e.target.value))}>{Array.from({ length: 14 }, (_, i) => <option key={i} value={i + 1}>{i + 1} {i === 0 ? "día" : "días"}</option>)}</SelectField><SelectField label="Local de la previsión" value={local} onChange={(e) => setLocal(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</SelectField><Button variant="outline" disabled={ejemplo} onClick={consulta.recargar}>Actualizar previsión</Button></div>
    <Notice>Es una estimación por tramos de 15 minutos. Usa el mismo día de la semana de hasta 12 semanas anteriores, con más peso a lo reciente. Los días cerrados no cuentan como cero. Lo ya reservado es el mínimo de la previsión final.</Notice>
    {ejemplo ? <Dias data={previsionEjemplo(from, days)} /> : <Resultado live={consulta.live}>{(data) => <Dias data={data} />}</Resultado>}
  </div>
}
function Dias({ data }: { data: CallableOutput<"previsionOcupacion"> }) {
  return <div className="space-y-5"><p className="text-sm text-muted-foreground">{data.seats} plazas habilitadas. Confianza baja con menos de 3 semanas, media de 3 a 7 y alta desde 8. Si la variación supera el 25 %, baja un nivel.</p>{data.days.length === 0 ? <Notice>No hay días disponibles en este periodo.</Notice> : data.days.map((day) => <Bloque key={day.date} title={`${day.date} · ${day.peak ? `punta a las ${day.peak}` : "sin hora punta"}`} description={`Confianza ${FORECAST_CONFIDENCE_LABEL[day.confidence]} · ${day.samples} semanas de respaldo${day.volatile ? " · variación alta entre semanas" : ""}`}>
    {day.samples === 0 ? <Notice tone="warning">Sin semanas históricas. Solo se cuenta lo ya reservado.</Notice> : null}
    <Grafica label={`Previsión y reservas del ${day.date}`} rows={day.slots.map((s) => ({ label: s.slot, value: s.projected, secondary: s.booked }))} />
    <details className="mt-4 text-sm"><summary className="cursor-pointer py-2">Ver tramos y semanas utilizadas</summary><p className="my-3 text-muted-foreground">Semanas: {day.sampleDates.join(", ") || "Ninguna"}.</p><div className="overflow-x-auto"><table className="w-full text-sm"><caption className="sr-only">Previsión por tramo del {day.date}</caption><thead><tr className="border-b text-left text-xs text-muted-foreground">{["Hora", "Histórico", "Reservados", "Previsión final", "Ocupación"].map((t) => <th className="py-3 pr-3" key={t}>{t}</th>)}</tr></thead><tbody className="divide-y">{day.slots.map((s) => <tr key={s.minutes} className="cifra">{[s.slot, s.expected, s.booked, s.projected, porcentaje(s.occupancyBp)].map((v, i) => <td key={i} className="py-3 pr-3">{v}</td>)}</tr>)}</tbody></table></div></details>
  </Bloque>)}</div>
}
