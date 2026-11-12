"use client"

import { TrashIcon } from "@phosphor-icons/react"
import { useId } from "react"
import { SegmentedControl } from "@/components/common/segmented-control"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { EditorArea, EditorTable } from "@/lib/plano/editor"

export interface InspectorActions {
  rename: (name: string) => void
  setSeats: (seats: number) => void
  setShape: (shape: "rect" | "round") => void
  setEnabled: (enabled: boolean) => void
  setArea: (areaId: string) => void
  setBox: (box: { x: number; y: number; w: number; h: number }) => void
  setJoinable: (other: string, joinable: boolean) => void
  remove: () => void
}

function NumberCell({ label, value, onChange, min, max }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number }) {
  return (
    <TextField
      label={label}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      className="cifra"
      value={Number.isFinite(value) ? Math.round(value) : ""}
      onChange={(e) => {
        const n = Number(e.target.value)
        if (e.target.value !== "" && Number.isFinite(n)) onChange(n)
      }}
    />
  )
}

/** Datos de la mesa elegida: lo mismo que se hace arrastrando, pero con campos (y con el teclado). */
export function TableInspector({
  table,
  areas,
  sameArea,
  problems,
  actions,
}: {
  table: EditorTable
  areas: EditorArea[]
  /** Otras mesas de la misma zona (con las que se puede unir). */
  sameArea: EditorTable[]
  problems: string[]
  actions: InspectorActions
}) {
  const enabledId = useId()
  return (
    <section aria-labelledby={`${enabledId}-title`} className="superficie flex min-w-0 flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${enabledId}-title`} className="text-base font-semibold">
          Mesa <span className="cifra">{table.name || "sin nombre"}</span>
        </h2>
        <Button variant="ghost" size="sm" onClick={actions.remove} className="text-destructive hover:text-destructive">
          <TrashIcon aria-hidden />
          Borrar
        </Button>
      </div>

      {problems.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs text-destructive" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <TextField label="Nombre" value={table.name} maxLength={20} className="cifra" onChange={(e) => actions.rename(e.target.value)} />
        <NumberCell label="Plazas" value={table.seats} min={1} max={30} onChange={actions.setSeats} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Forma</span>
        <SegmentedControl
          label="Forma de la mesa"
          value={table.shape}
          onValueChange={actions.setShape}
          options={[
            { value: "rect", label: "Rectangular" },
            { value: "round", label: "Redonda" },
          ]}
          className="self-start"
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={enabledId} className="flex min-h-11 flex-1 flex-col items-start justify-center gap-0.5">
          <span>Habilitada</span>
          <span className="text-xs font-normal text-muted-foreground">Las deshabilitadas no se ofrecen al reservar.</span>
        </Label>
        <Switch id={enabledId} checked={table.enabled} onCheckedChange={actions.setEnabled} />
      </div>

      {areas.length > 1 ? (
        <SelectField label="Zona" value={table.areaId} onChange={(e) => actions.setArea(e.target.value)} hint="Al cambiar de zona se quitan sus uniones.">
          {areas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name || "Zona sin nombre"}
            </option>
          ))}
        </SelectField>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Posición y tamaño (de 0 a 100)</legend>
        <div className="grid grid-cols-4 gap-2">
          <NumberCell label="X" value={table.x} min={0} max={100} onChange={(x) => actions.setBox({ ...table, x })} />
          <NumberCell label="Y" value={table.y} min={0} max={100} onChange={(y) => actions.setBox({ ...table, y })} />
          <NumberCell label="Ancho" value={table.w} min={4} max={100} onChange={(w) => actions.setBox({ ...table, w })} />
          <NumberCell label="Alto" value={table.h} min={4} max={100} onChange={(h) => actions.setBox({ ...table, h })} />
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-sm font-medium">Se puede juntar con</legend>
        <p className="mb-2 text-xs text-muted-foreground">Solo mesas de la misma zona. La unión vale en los dos sentidos.</p>
        {sameArea.length === 0 ? (
          <p className="text-xs text-muted-foreground">No hay más mesas en esta zona.</p>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {sameArea.map((o) => {
              const id = `${enabledId}-join-${o.id}`
              return (
                <li key={o.id} className="flex min-h-11 items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={table.joinableWith.includes(o.id)}
                    onCheckedChange={(v) => actions.setJoinable(o.id, v === true)}
                  />
                  <Label htmlFor={id} className="cifra flex min-h-11 flex-1 items-center font-normal">
                    {o.name || "—"}
                  </Label>
                </li>
              )
            })}
          </ul>
        )}
      </fieldset>
    </section>
  )
}
