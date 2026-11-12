"use client"

import { useState } from "react"
import { AnalyticsSettingsSchema, horaLocal, sumarDias, type AnalyticsSettings } from "@llenamos/core"
import { usePanel } from "@/components/panel/PanelContext"
import { DateInput } from "@/components/common/date-picker"
import { SelectField, TextField } from "@/components/common/form-fields"
import { TimeSelectField } from "@/components/common/time-select-field"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { useNow } from "@/lib/use-now"
import { useMembers } from "@/lib/data/hooks"
import { accesoAnalisis, buscarUltimoResumen, errorAnalisis } from "@/lib/analisis/api"
import { useAccion, useAjustes, useConsulta, useUltimoResumen } from "@/lib/analisis/datos"
import { resumenEjemplo } from "@/lib/analisis/fixtures"
import { Bloque, EstadoAccion, Resultado } from "./piezas"

/** La lectura en vivo ya trae la fecha del último resumen: sin ella (o sin resumen guardado) se dice, no se inventa. */
function ultimoDeLaApi(live: ReturnType<typeof useUltimoResumen>["api"]): { date: string } {
  if (live.status === "error") throw live.error
  if (live.status === "loading") throw new Error("Todavía se está comprobando cuál es el último resumen. Inténtalo de nuevo en unos segundos.")
  if (live.data === null) throw new Error("No hay resúmenes guardados que puedas ver. Puedes consultar una fecha concreta.")
  return live.data
}

export function Resumen({ ejemplo }: { ejemplo: boolean }) {
  const { restaurant, user, role } = usePanel()
  const hoy = horaLocal(useNow(60_000).getTime(), restaurant.timezone).fecha
  const [date, setDate] = useState(sumarDias(hoy, -1))
  const [buscando, setBuscando] = useState(false), [searchError, setSearchError] = useState<unknown>(null)
  const equipo = useMembers(restaurant.id)
  const ajustes = useAjustes(ejemplo ? null : restaurant.id)
  const ultimo = useUltimoResumen(ejemplo ? null : restaurant.id)
  const consulta = useConsulta("verResumenDiario", ejemplo ? null : { restaurantId: restaurant.id, date })
  const inicial: AnalyticsSettings = { dailySummary: { enabled: false, hour: "09:00", channels: ["email"], recipientUids: [user.uid], covers: "previous" }, forecast: { lowOccupancyBp: 3000, highOccupancyBp: 8500, daysAhead: 7 }, lapsedAfterDays: 60 }
  return <div className="space-y-5">
    <Bloque title="Consultar un resumen" description="El proceso guarda un resumen por fecha. Busca el último disponible o elige otra fecha."><div className="mb-4 flex flex-wrap items-end gap-3"><DateInput label="Día del resumen" clearable={false} value={date} onChange={(v) => v && setDate(v)} /><Button variant="outline" disabled={ejemplo} onClick={consulta.recargar}>Consultar de nuevo</Button><Button variant="outline" disabled={ejemplo || buscando} onClick={async () => { setBuscando(true); setSearchError(null); try { const r = ultimo.vps ? ultimoDeLaApi(ultimo.api) : await buscarUltimoResumen(restaurant.id, hoy); setDate(r.date); consulta.recargar() } catch (e) { setSearchError(e) } finally { setBuscando(false) } }}>{buscando ? "Buscando el último…" : "Buscar último disponible"}</Button></div>{searchError ? <Notice tone="error">{errorAnalisis(searchError)}</Notice> : null}{ejemplo ? <div className="space-y-3"><p className="whitespace-pre-wrap text-sm leading-7">{resumenEjemplo(date)}</p><p className="text-xs text-warning">Texto de ejemplo calculado con core. No se ha enviado.</p></div> : <Resultado live={consulta.live}>{(r) => <><p className="whitespace-pre-wrap text-sm leading-7">{r.text}</p><ul className="mt-4 divide-y">{r.sentTo.map((s, i) => <li key={i} className="py-3 text-sm">{equipo.status === "ready" ? equipo.data.find((m) => m.uid === s.uid)?.displayName ?? "Persona del equipo" : "Persona del equipo"} · {s.channel === "email" ? "Correo" : "WhatsApp"} · {s.status === "captured" ? "Capturado en el emulador, sin envío real" : s.status === "not_configured" ? "Proveedor sin configurar, no enviado" : ({ queued: "En cola", sent: "Enviado", failed: "Fallido", cancelled: "Cancelado", pending: "Pendiente" } as Record<string, string>)[s.status] ?? "Estado pendiente de confirmar"}</li>)}</ul>{r.sentTo.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No hay destinatarios registrados para este resumen.</p> : null}</>}</Resultado>}</Bloque>
    {accesoAnalisis("guardarConfiguracionAnalisis", role, restaurant) ? ejemplo ? <Editor inicial={inicial} ejemplo /> : <Resultado live={ajustes}>{(data) => <Editor key={JSON.stringify(data)} inicial={data ?? inicial} ejemplo={false} nuevo={data === null} />}</Resultado> : null}
  </div>
}
function Editor({ inicial, ejemplo, nuevo = false }: { inicial: AnalyticsSettings; ejemplo: boolean; nuevo?: boolean }) {
  const { restaurant } = usePanel()
  const miembros = useMembers(restaurant.id)
  const [settings, setSettings] = useState(inicial)
  const accion = useAccion()
  const valid = AnalyticsSettingsSchema.safeParse(settings)
  const daily = settings.dailySummary
  const patch = (p: Partial<typeof daily>) => { accion.clear(); setSettings({ ...settings, dailySummary: { ...daily, ...p } }) }
  const forecast = (p: Partial<AnalyticsSettings["forecast"]>) => { accion.clear(); setSettings({ ...settings, forecast: { ...settings.forecast, ...p } }) }
  return <Bloque title="Resumen y umbrales" description="Solo se guarda tras la confirmación del servidor. Sin proveedor configurado no sale ningún mensaje.">
    {nuevo ? <Notice>No hay ajustes guardados. Estos son valores propuestos y el resumen empieza apagado.</Notice> : null}
    <div className="mt-4 grid gap-4 sm:grid-cols-2"><SelectField label="Resumen diario" value={String(daily.enabled)} onChange={(e) => patch({ enabled: e.target.value === "true" })}><option value="false">Apagado</option><option value="true">Encendido</option></SelectField><TimeSelectField label="Hora local de envío" value={daily.hour} onChange={(hour) => patch({ hour })} /><SelectField label="Qué día resume" value={daily.covers} onChange={(e) => patch({ covers: e.target.value as typeof daily.covers })}><option value="previous">El día anterior</option><option value="same">El mismo día</option></SelectField><SelectField label="Canales" value={daily.channels.length === 2 ? "both" : daily.channels[0]} onChange={(e) => patch({ channels: e.target.value === "both" ? ["email", "whatsapp"] : [e.target.value as "email" | "whatsapp"] })}><option value="email">Correo</option><option value="whatsapp">WhatsApp</option><option value="both">Correo y WhatsApp</option></SelectField>
      <TextField label="Ocupación baja, puntos básicos" type="number" min={0} max={10000} step={1} hint="3000 equivale al 30 %." value={settings.forecast.lowOccupancyBp} onChange={(e) => forecast({ lowOccupancyBp: Number(e.target.value) })} /><TextField label="Ocupación alta, puntos básicos" type="number" min={0} max={10000} value={settings.forecast.highOccupancyBp} onChange={(e) => forecast({ highOccupancyBp: Number(e.target.value) })} /><TextField label="Días de antelación de los avisos" type="number" min={1} max={14} value={settings.forecast.daysAhead} onChange={(e) => forecast({ daysAhead: Number(e.target.value) })} /><TextField label="Días sin venir para avisar" type="number" min={7} max={365} value={settings.lapsedAfterDays} onChange={(e) => { accion.clear(); setSettings({ ...settings, lapsedAfterDays: Number(e.target.value) }) }} /></div>
    <fieldset className="my-5"><legend className="mb-2 text-sm font-medium">Quién lo recibe</legend><Resultado live={miembros}>{(ms) => <div className="space-y-2">{ms.filter((m) => m.active && ["owner", "manager"].includes(m.role)).map((m) => <label key={m.uid} className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={daily.recipientUids.includes(m.uid)} onChange={(e) => patch({ recipientUids: e.target.checked ? [...daily.recipientUids, m.uid] : daily.recipientUids.filter((id) => id !== m.uid) })} />{m.displayName}</label>)}</div>}</Resultado></fieldset>
    {!valid.success ? <Notice tone="warning">{valid.error.issues.map((i) => i.message).join(" ")}</Notice> : null}
    <Button className="my-4" disabled={ejemplo || accion.pending || !valid.success || miembros.status !== "ready"} onClick={() => accion.run("guardarConfiguracionAnalisis", { restaurantId: restaurant.id, settings }, "Configuración guardada por el servidor.")}>Guardar configuración</Button><EstadoAccion accion={accion} />
  </Bloque>
}
