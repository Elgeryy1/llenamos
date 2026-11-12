"use client"

import { AUTOMATION_EVENTS, type AutomationEvent, type Comparison, type ConditionGroup } from "@llenamos/core"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"

export const CAMPOS: Record<string, string> = { partySize: "Comensales", customerNoShows: "No presentados del cliente", hasDeposit: "Tiene señal", hoursBeforeStart: "Horas hasta la llegada", occupancyBp: "Ocupación en puntos básicos", daysAhead: "Días de antelación", confidence: "Confianza", level: "Existencias", daysToRunOut: "Días hasta agotarse", daysSinceVisit: "Días sin venir", visits: "Visitas", spentCents: "Gasto en céntimos", grossSalesCents: "Ventas brutas en céntimos", salesDeltaBp: "Cambio de ventas en puntos básicos", noShowBp: "No presentados en puntos básicos" }
const OPERADORES: Record<Comparison["op"], string> = { eq: "Igual a", neq: "Distinto de", gt: "Mayor que", gte: "Como mínimo", lt: "Menor que", lte: "Como máximo", in: "Está en la lista" }
export const condicionInicial = (event: AutomationEvent): Comparison => ({ field: AUTOMATION_EVENTS[event][0], op: "gte", value: 1 })
const valor = (raw: string, field: string): string | number | boolean => {
  const normalized = raw.trim().toLocaleLowerCase("es")
  if (field === "hasDeposit") {
    if (["sí", "si", "true"].includes(normalized)) return true
    if (["no", "false"].includes(normalized)) return false
  }
  if (field === "confidence") return ({ baja: "low", media: "medium", alta: "high" } as Record<string, string>)[normalized] ?? normalized
  return /^-?\d+$/.test(raw) ? Number(raw) : raw
}
const mostrarValor = (value: string | number | boolean, field: string) => typeof value === "boolean" ? (value ? "Sí" : "No") : field === "confidence" ? ({ low: "Baja", medium: "Media", high: "Alta" } as Record<string, string>)[String(value)] ?? String(value) : String(value)

export function Condiciones({ event, group, onChange, depth = 1 }: { event: AutomationEvent; group: ConditionGroup; onChange: (g: ConditionGroup) => void; depth?: number }) {
  const mode = "all" in group ? "all" : "any"
  const items = "all" in group ? group.all : group.any
  const replace = (xs: (Comparison | ConditionGroup)[]) => onChange(mode === "all" ? { all: xs } : { any: xs })
  return <fieldset className="min-w-0 space-y-3 rounded-lg border p-3"><legend className="px-1 text-sm">{depth === 1 ? "Condiciones del evento" : "Grupo de condiciones"}</legend>
    <SelectField label="Cuándo se cumple" value={mode} onChange={(e) => onChange(e.target.value === "all" ? { all: items } : { any: items.length ? items : [condicionInicial(event)] })}><option value="all">Se cumplen todas</option><option value="any">Se cumple alguna</option></SelectField>
    {items.length === 0 ? <p className="text-sm text-muted-foreground">Se cumple con cualquier evento de este tipo.</p> : null}
    {items.map((item, i) => <div key={i} className="min-w-0 space-y-3 border-t pt-3">{"field" in item ? <div className="grid gap-3 sm:grid-cols-3"><SelectField label={`Dato ${i + 1}`} value={item.field} onChange={(e) => replace(items.map((c, j) => j === i ? { ...item, field: e.target.value, value: 1 } : c))}>{AUTOMATION_EVENTS[event].map((field) => <option key={field} value={field}>{CAMPOS[field] ?? field}</option>)}</SelectField><SelectField label={`Comparación ${i + 1}`} value={item.op} onChange={(e) => replace(items.map((c, j) => j === i ? { ...item, op: e.target.value as Comparison["op"], value: e.target.value === "in" ? [1] : 1 } : c))}>{Object.entries(OPERADORES).map(([k, v]) => <option value={k} key={k}>{v}</option>)}</SelectField><TextField label={`Valor ${i + 1}`} value={Array.isArray(item.value) ? item.value.map((v) => mostrarValor(v, item.field)).join(", ") : mostrarValor(item.value, item.field)} hint={item.field === "confidence" ? "Baja, media o alta" : item.field === "hasDeposit" ? "Sí o No" : item.op === "in" ? "Valores separados por comas" : "Número entero o texto"} onChange={(e) => replace(items.map((c, j) => j === i ? { ...item, value: item.op === "in" ? e.target.value.split(",").map((v) => valor(v.trim(), item.field)) : valor(e.target.value, item.field) } : c))} /></div> : <Condiciones event={event} group={item} depth={depth + 1} onChange={(g) => replace(items.map((c, j) => j === i ? g : c))} />}<Button variant="ghost" onClick={() => replace(items.filter((_, j) => i !== j))}>Quitar {"field" in item ? "condición" : "grupo"} {i + 1}</Button></div>)}
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={items.length >= 10} onClick={() => replace([...items, condicionInicial(event)])}>Añadir condición</Button>{depth < 2 ? <Button variant="outline" disabled={items.length >= 10} onClick={() => replace([...items, { all: [condicionInicial(event)] }])}>Añadir grupo</Button> : null}</div>
  </fieldset>
}
