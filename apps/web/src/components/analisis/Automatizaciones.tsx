"use client"

import { useState } from "react"
import Link from "next/link"
import { AUTOMATION_EVENT_LABEL, AUTOMATION_EVENT_NAMES, AutomationRuleInputSchema, RECOMMENDATIONS, RECOMMENDATION_LABEL, horaLocal, sumarDias, type AutomationRuleInput, type CallableOutput, type Recommendation } from "@llenamos/core"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import { SelectField, TextareaField, TextField } from "@/components/common/form-fields"
import { DateInput } from "@/components/common/date-picker"
import { Notice } from "@/components/common/notice"
import { useCloseOnHide } from "@/lib/open-state"
import { useNow } from "@/lib/use-now"
import { accesoAnalisis, llamarAnalisis, errorAnalisis } from "@/lib/analisis/api"
import { useAccion, useRecomendaciones, useReglas } from "@/lib/analisis/datos"
import { Bloque, EstadoAccion, Resultado } from "./piezas"
import { recomendacionEjemplo } from "@/lib/analisis/fixtures"
import { CAMPOS, Condiciones } from "./Condiciones"

const NUEVA: AutomationRuleInput = { name: "", enabled: true, event: "reservation.no_show", conditions: { all: [{ field: "customerNoShows", op: "gte", value: 2 }] }, recommendation: { kind: "require_deposit", note: null, segmentId: null }, cooldownMinutes: 1440, locationIds: [] }
const DESTINOS = { require_deposit: "/panel/horarios", contact_customer: "/panel/clientes", launch_campaign: "/panel/campanas", open_waitlist: "/panel/lista-espera", adjust_staffing: "/panel/personal/cuadrante", review_stock: "/panel/inventario", review_day: "/panel/analisis" }

export function Automatizaciones({ ejemplo }: { ejemplo: boolean }) {
  const { restaurant, role } = usePanel()
  const now = useNow(60_000).getTime()
  const reglas = useReglas(ejemplo ? null : restaurant.id)
  const recomendaciones = useRecomendaciones(ejemplo ? null : restaurant.id)
  const [editor, setEditor] = useState<{ id: string | null; revision: number | null; rule: AutomationRuleInput } | null>(null)
  useCloseOnHide(() => setEditor(null))
  const configurar = accesoAnalisis("guardarAutomatizacion", role, restaurant)
  return <div className="space-y-5"><Notice title="Solo recomendaciones">Aceptar registra tu decisión. No envía campañas, no cambia reservas y no hace pedidos. Cada acción se hace a mano desde su pantalla.</Notice>
    <Bloque title="Recomendaciones del servicio" description="Las últimas 100 recomendaciones, con la evidencia que las originó.">{ejemplo ? <Recomendacion item={recomendacionEjemplo(now)} ejemplo /> : <Resultado live={recomendaciones}>{(rows) => rows.length ? <div className="divide-y">{rows.map((r) => <Recomendacion key={r.id} item={r} />)}</div> : <p className="text-sm text-muted-foreground">Todavía no hay recomendaciones.</p>}</Resultado>}</Bloque>
    {configurar ? <><Bloque title="Reglas del restaurante" description="Hasta 100 reglas por nombre. Se simulan sobre eventos guardados de un máximo de 92 días."><Button variant="outline" onClick={() => setEditor({ id: null, revision: null, rule: NUEVA })}>Crear regla</Button>{ejemplo ? <p className="mt-4 text-sm text-muted-foreground">El editor está disponible para revisar el diseño. No guarda ni simula datos reales.</p> : <Resultado live={reglas}>{(rows) => rows.length ? <div className="mt-4 divide-y">{rows.map((r) => <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm"><div><strong>{r.rule.name}</strong><p className="mt-1 text-muted-foreground">{AUTOMATION_EVENT_LABEL[r.rule.event]} · {r.rule.enabled ? "Encendida" : "Apagada"} · revisión {r.revision}</p></div><Button variant="outline" onClick={() => setEditor(r)}>Editar regla</Button></div>)}</div> : <p className="mt-4 text-sm text-muted-foreground">No hay reglas guardadas.</p>}</Resultado>}</Bloque>{editor ? <Editor key={`${editor.id}:${editor.revision}`} initial={editor} ejemplo={ejemplo} onClose={() => setEditor(null)} /> : null}</> : null}
  </div>
}
function Recomendacion({ item, ejemplo = false }: { item: Recommendation & { id: string }; ejemplo?: boolean }) {
  const { restaurant } = usePanel()
  const now = useNow(60_000).getTime()
  const accion = useAccion()
  const [note, setNote] = useState("")
  const [decision, setDecision] = useState<"accepted" | "dismissed" | null>(null)
  const open = item.status === "open" && item.expiresAt > now && decision === null
  const status = decision ?? (item.status === "open" && item.expiresAt <= now ? "expired" : item.status)
  return <article className="space-y-3 py-4"><p className="font-medium">{item.text || RECOMMENDATION_LABEL[item.kind]}</p><p className="text-xs text-muted-foreground">{({ open: "Pendiente", accepted: "Aceptada", dismissed: "Descartada", expired: "Caducada" })[status]} · {item.subject}</p><dl className="flex flex-wrap gap-3 text-sm">{Object.entries(item.evidence).map(([k, v]) => <div key={k}><dt className="text-xs text-muted-foreground">{CAMPOS[k] ?? k}</dt><dd className="cifra">{typeof v === "boolean" ? (v ? "Sí" : "No") : String(v)}</dd></div>)}</dl>{open ? <><TextField label="Nota sobre la decisión" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} /><div className="flex flex-wrap gap-2">{(["accepted", "dismissed"] as const).map((d) => <Button key={d} variant="outline" disabled={ejemplo || accion.pending} onClick={async () => { const result = await accion.run("resolverRecomendacion", { restaurantId: restaurant.id, recommendationId: item.id, decision: d, note: note || null }, "Decisión registrada. No se ha ejecutado ninguna acción."); if (result) setDecision(result.status) }}>{d === "accepted" ? "Aceptar recomendación" : "Descartar"}</Button>)}</div></> : null}<Link className="inline-flex min-h-11 items-center text-sm text-primary underline" href={DESTINOS[item.kind]}>Ir a la pantalla para hacerlo a mano</Link><EstadoAccion accion={accion} /></article>
}
function Editor({ initial, ejemplo, onClose }: { initial: { id: string | null; revision: number | null; rule: AutomationRuleInput }; ejemplo: boolean; onClose: () => void }) {
  const { restaurant, locations } = usePanel()
  const hoy = horaLocal(useNow(60_000).getTime(), restaurant.timezone).fecha
  const [rule, setRule] = useState(initial.rule)
  const [identity, setIdentity] = useState({ id: initial.id, revision: initial.revision })
  const [from, setFrom] = useState(sumarDias(hoy, -91)), [to, setTo] = useState(hoy)
  const [simulation, setSimulation] = useState<{ key: string; data: CallableOutput<"simularAutomatizacion"> } | null>(null)
  const [simError, setSimError] = useState<unknown>(null), [pending, setPending] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const accion = useAccion()
  const parsed = AutomationRuleInputSchema.safeParse(rule)
  const simulationKey = JSON.stringify([rule, from, to])
  const data = simulation?.key === simulationKey ? simulation.data : null
  const set = (p: Partial<AutomationRuleInput>) => { accion.clear(); setRule({ ...rule, ...p }) }
  return <Bloque title={identity.id ? "Editar regla" : "Nueva regla"} description="Las condiciones usan los campos del evento elegido. Se admiten grupos de todas o alguna condición, hasta dos niveles."><div className="space-y-5">
    <div className="grid gap-4 sm:grid-cols-2"><TextField label="Nombre de la regla" value={rule.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} /><SelectField label="Estado de la regla" value={String(rule.enabled)} onChange={(e) => set({ enabled: e.target.value === "true" })}><option value="true">Encendida</option><option value="false">Apagada</option></SelectField><SelectField label="Cuando ocurra" value={rule.event} onChange={(e) => set({ event: e.target.value as typeof rule.event, conditions: { all: [] } })}>{AUTOMATION_EVENT_NAMES.map((e) => <option key={e} value={e}>{AUTOMATION_EVENT_LABEL[e]}</option>)}</SelectField><TextField label="Minutos sin repetir para el mismo asunto" type="number" min={0} max={129600} value={rule.cooldownMinutes} onChange={(e) => set({ cooldownMinutes: Number(e.target.value) })} /></div>
    <Condiciones event={rule.event} group={rule.conditions} onChange={(conditions) => set({ conditions })} />
    <SelectField label="Qué recomendar" value={rule.recommendation.kind} onChange={(e) => set({ recommendation: { ...rule.recommendation, kind: e.target.value as typeof rule.recommendation.kind } })}>{RECOMMENDATIONS.map((r) => <option key={r} value={r}>{RECOMMENDATION_LABEL[r]}</option>)}</SelectField>
    {rule.recommendation.kind === "launch_campaign" ? <TextField label="Identificador del segmento" value={rule.recommendation.segmentId ?? ""} onChange={(e) => set({ recommendation: { ...rule.recommendation, segmentId: e.target.value || null } })} /> : null}
    <TextareaField label="Texto de apoyo" maxLength={200} value={rule.recommendation.note ?? ""} onChange={(e) => set({ recommendation: { ...rule.recommendation, note: e.target.value || null } })} />
    <fieldset><legend className="mb-2 text-sm font-medium">Locales de la regla</legend><p className="text-xs text-muted-foreground">Sin marcar ninguno, se aplica a todos los locales autorizados por el servidor.</p>{locations.map((l) => <label key={l.id} className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={rule.locationIds.includes(l.id)} onChange={(e) => set({ locationIds: e.target.checked ? [...rule.locationIds, l.id] : rule.locationIds.filter((id) => id !== l.id) })} />{l.name}</label>)}</fieldset>
    {!parsed.success ? <Notice tone="warning">{parsed.error.issues.map((i) => i.message).join(" ")}</Notice> : null}
    <div className="flex flex-wrap gap-3"><Button disabled={ejemplo || accion.pending || pending || !parsed.success} onClick={async () => { const result = await accion.run("guardarAutomatizacion", { restaurantId: restaurant.id, ruleId: identity.id, expectedRevision: identity.revision, rule }, "Regla guardada por el servidor."); if (result) setIdentity({ id: result.ruleId, revision: result.revision }) }}>Guardar regla</Button><Button variant="ghost" onClick={onClose}>Cerrar editor</Button>{identity.id ? <Button variant="outline" disabled={ejemplo || accion.pending || pending} onClick={() => setConfirmDelete(true)}>Borrar regla</Button> : null}</div>
    {confirmDelete ? <Notice tone="warning" title="Confirma el borrado de esta regla" action={<Button variant="outline" disabled={accion.pending} onClick={async () => { if (!identity.id || !identity.revision) return; const r = await accion.run("borrarAutomatizacion", { restaurantId: restaurant.id, ruleId: identity.id, expectedRevision: identity.revision }, "Regla borrada."); if (r) onClose() }}>Confirmar borrado</Button>}>Las recomendaciones anteriores se conservan. <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Conservar regla</Button></Notice> : null}<EstadoAccion accion={accion} />
    <div className="space-y-4 border-t pt-5"><h3 className="font-medium">Probar con el historial</h3><div className="flex flex-wrap items-end gap-3"><DateInput label="Simular desde" value={from} clearable={false} onChange={(v) => v && setFrom(v)} /><DateInput label="Simular hasta" value={to} clearable={false} min={from} onChange={(v) => v && setTo(v)} /><Button variant="outline" disabled={ejemplo || pending || accion.pending || !parsed.success || from > to || sumarDias(from, 91) < to} onClick={async () => { setPending(true); setSimError(null); try { const r = await llamarAnalisis("simularAutomatizacion", { restaurantId: restaurant.id, rule, from, to }); setSimulation({ key: simulationKey, data: r }) } catch (e) { setSimError(e) } finally { setPending(false) } }}>Simular sin guardar</Button></div><p className="text-xs text-muted-foreground">Máximo 92 días. La simulación respeta el enfriamiento y no escribe ni ejecuta nada.</p>{simError ? <Notice tone="error">{errorAnalisis(simError)}</Notice> : null}{data ? <div role="status" className="space-y-3 text-sm"><p>{data.events} eventos analizados · {data.fired.length} recomendaciones.</p><p className="text-muted-foreground">Descartados: {data.skipped.event} por evento, {data.skipped.location} por local, {data.skipped.conditions} por condiciones y {data.skipped.cooldown} por enfriamiento.</p><ul className="divide-y">{data.fired.map((f) => <li key={f.eventId} className="py-3">{new Date(f.at).toLocaleString("es", { timeZone: restaurant.timezone })} · {f.subject}</li>)}</ul></div> : null}</div>
  </div></Bloque>
}
