"use client"

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react"
import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { canDeleteArea, sortedAreas, tablesOf, type PlanoDraft } from "@/lib/plano/editor"

/** Zonas del local: nombre, orden (subir y bajar) y alta o baja de zonas vacías. */
export function AreasEditor({
  draft,
  problemIds,
  onRename,
  onMove,
  onDelete,
  onAdd,
}: {
  draft: PlanoDraft
  problemIds: ReadonlySet<string>
  onRename: (id: string, name: string) => void
  onMove: (id: string, direction: -1 | 1) => void
  onDelete: (id: string) => void
  onAdd: (name: string) => void
}) {
  const [name, setName] = useState("")
  const areas = sortedAreas(draft)

  function add(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    onAdd(name.trim())
    setName("")
  }

  return (
    <section aria-labelledby="zonas-titulo" className="superficie flex min-w-0 flex-col gap-3 p-4">
      <h2 id="zonas-titulo" className="text-base font-semibold">
        Zonas
      </h2>
      <ol className="flex flex-col divide-y">
        {areas.map((a, i) => {
          const count = tablesOf(draft, a.id).length
          const deletable = canDeleteArea(draft, a.id)
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-1 py-2">
              <Input
                aria-label={`Nombre de la zona ${i + 1}`}
                value={a.name}
                maxLength={40}
                aria-invalid={problemIds.has(a.id) || undefined}
                onChange={(e) => onRename(a.id, e.target.value)}
                className="h-9 min-w-20 flex-1"
              />
              <span className="cifra w-14 shrink-0 text-right text-xs text-muted-foreground">
                {count} {count === 1 ? "mesa" : "mesas"}
              </span>
              <Button variant="ghost" size="icon" className="pointer-coarse:min-w-11" aria-label={`Subir ${a.name}`} disabled={i === 0} onClick={() => onMove(a.id, -1)}>
                <ArrowUpIcon aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon" className="pointer-coarse:min-w-11"
                aria-label={`Bajar ${a.name}`}
                disabled={i === areas.length - 1}
                onClick={() => onMove(a.id, 1)}
              >
                <ArrowDownIcon aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon" className="pointer-coarse:min-w-11"
                aria-label={deletable ? `Borrar ${a.name}` : `${a.name} tiene mesas: muévelas o bórralas antes`}
                title={deletable ? "Borrar zona" : "Solo se borra una zona vacía"}
                disabled={!deletable}
                onClick={() => onDelete(a.id)}
              >
                <TrashIcon aria-hidden />
              </Button>
            </li>
          )
        })}
      </ol>
      <form onSubmit={add} className="flex flex-wrap gap-2">
        <Input aria-label="Nombre de la zona nueva" placeholder="Terraza, reservado…" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} className="h-9 min-w-0 flex-1 basis-32" />
        <Button type="submit" variant="outline" size="sm" disabled={!name.trim()}>
          <PlusIcon aria-hidden />
          Añadir zona
        </Button>
      </form>
    </section>
  )
}
