"use client"

import { horaLocal } from "@llenamos/core"
import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useState } from "react"
import { platosDeEstacion, type ItemDoc, type StationDoc } from "@/lib/cocina/modelo"

export function Agotados({ items, stations, station, defaultStationId, disabled, onChange, onPortions, timezone, now, allItems = false }: {
  items: ItemDoc[]; stations: StationDoc[]; station: StationDoc; defaultStationId: string | null; disabled: boolean
  allItems?: boolean
  timezone?: string; now?: number
  onPortions?: (itemId: string, variantId: string | null, remaining: number | null) => void
  onChange: (itemId: string, optionId: string | null, soldOut: boolean) => void
}) {
  const [search, setSearch] = useState("")
  const propios = useMemo(() => allItems ? items.filter(item => item.active) : platosDeEstacion(items, stations, station, defaultStationId), [items, stations, station, defaultStationId, allItems])
  const visibles = propios.filter((item) => item.name.es.toLocaleLowerCase("es").includes(search.toLocaleLowerCase("es")))
  return (
    <section className="superficie overflow-hidden" aria-label="Disponibilidad de la estación">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b p-5">
        <div><h2 className="text-lg font-semibold">Agotados de {station.name}</h2><p className="mt-1 text-sm text-muted-foreground">{allItems ? "Carta disponible de este local." : "Solo cambia la disponibilidad de esta estación."}</p></div>
        <Input aria-label="Buscar un plato" placeholder="Buscar un plato…" className="h-12 max-w-sm" value={search} onChange={(e) => setSearch(e.target.value)} />
      </header>
      <ul className="divide-y">{visibles.map((item) => <li key={item.id} className="px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-lg font-medium">{item.name.es}</p><p className={item.soldOut ? "text-warning" : "text-muted-foreground"}>{item.soldOut ? "Agotado" : "Disponible"}</p></div>
          <Button className="h-12" variant="outline" disabled={disabled} onClick={() => onChange(item.id, null, !item.soldOut)}>{item.soldOut ? "Volver a ofrecer" : "Marcar agotado"}<span className="sr-only">: {item.name.es}</span></Button></div>
        {onPortions ? <div className="mt-4 space-y-2 border-t pt-3"><p className="text-sm text-muted-foreground">Recuento de {horaLocal(now ?? 0, timezone ?? "Europe/Madrid").fecha}. Cada día se cuenta de nuevo antes de vender. Anular no repone raciones. El recuento total limita también las variantes.</p>
          {item.portions && item.portions.date !== horaLocal(now ?? 0, timezone ?? "Europe/Madrid").fecha ? <p className="text-warning">Recuento de {item.portions.date} caducado. Guarda el de hoy para volver a vender.</p> : null}
          <Recuento key={`${item.id}:total:${item.portions?.remaining}:${item.portions?.date}`} name={`Total de ${item.name.es}`} value={item.portions?.remaining ?? null} disabled={disabled} onSave={(n) => onPortions(item.id, null, n)} />
          {item.variants.map(v => <Recuento key={`${item.id}:${v.id}:${item.portions?.variants[v.id]}:${item.portions?.date}`} name={`${item.name.es} · ${v.name.es}`} value={item.portions?.variants[v.id] ?? null} disabled={disabled} onSave={(n) => onPortions(item.id, v.id, n)} />)}
        </div> : null}
        {item.modifierGroups.flatMap((group) => group.options.map((option) => <div key={option.id} className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 pl-4"><span>{group.name.es} · {option.name.es} · {option.soldOut ? "Agotado" : "Disponible"}</span><Button variant="ghost" className="h-12" disabled={disabled} onClick={() => onChange(item.id, option.id, !option.soldOut)}>{option.soldOut ? "Ofrecer extra" : "Agotar extra"}<span className="sr-only">: {option.name.es} de {item.name.es}</span></Button></div>))}
      </li>)}</ul>
      {visibles.length === 0 ? <p className="p-5 text-muted-foreground">{propios.length ? "No hay platos con ese nombre." : "No hay platos activos asignados a esta estación."}</p> : null}
    </section>
  )
}

function Recuento({ name, value, disabled, onSave }: { name: string; value: number | null; disabled: boolean; onSave: (n: number | null) => void }) {
  const [amount, setAmount] = useState(value === null ? "" : String(value))
  const valid = amount === "" || /^\d{1,4}$/.test(amount)
  return <form className="flex flex-wrap items-center gap-3" onSubmit={e => { e.preventDefault(); if (valid) onSave(amount === "" ? null : Number(amount)) }}>
    <label className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-base">{name}<Input aria-label={`Raciones de ${name}`} inputMode="numeric" className="h-12 w-28" value={amount} placeholder="Sin límite" onChange={e => setAmount(e.target.value)} /></label>
    <span className={value === 0 ? "text-warning" : "text-muted-foreground"}>{value === null ? "Sin límite" : `${value} raciones`}</span>
    <Button variant="outline" className="h-12" type="submit" disabled={disabled || !valid}>Guardar recuento<span className="sr-only"> de {name}</span></Button>
  </form>
}
