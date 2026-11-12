"use client"

import type { Shift } from "@llenamos/core"
import { PlusIcon, XIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { errorsUnder, intToInput, shiftLimitFromInput, type FieldPath } from "@/lib/horarios/form"
import { TimeInput } from "./campos"

/**
 * Turnos de un día (de la semana o de un día especial): nombre, primera llegada,
 * última llegada y, si se quiere, límite de comensales por franja y por turno.
 * `path` es la ruta del error («week.tue», «exceptions.2.shifts»).
 */
export function ShiftsEditor({
  label,
  shifts,
  path,
  errors,
  onChange,
  onAdd,
  onRemove,
  emptyText = "Cerrado",
}: {
  label: string
  shifts: Shift[]
  path: FieldPath
  errors: Record<FieldPath, string>
  onChange: (index: number, patch: Partial<Shift>) => void
  onAdd: () => void
  onRemove: (index: number) => void
  emptyText?: string
}) {
  return (
    <div className="@container/turnos flex flex-col gap-4">
      {shifts.length === 0 ? <p className="text-sm text-muted-foreground">{emptyText}</p> : null}
      {shifts.map((s, i) => {
        const p = `${path}.${i}`
        const rowErrors = errorsUnder(errors, p)
        return (
          <div key={i} className="flex flex-col gap-1">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.75rem] items-end gap-x-2 gap-y-3 @min-[650px]/turnos:grid-cols-[minmax(90px,1.4fr)_repeat(4,minmax(70px,1fr))_2.75rem]">
              <Label className="col-span-2 min-w-0 flex-col items-start gap-1.5 @min-[650px]/turnos:col-span-1">
                <span className="text-xs text-muted-foreground">Turno</span>
                <Input
                  aria-label={`Nombre del turno ${i + 1} del ${label}`}
                  value={s.name}
                  maxLength={40}
                  aria-invalid={errors[`${p}.name`] ? true : undefined}
                  onChange={(e) => onChange(i, { name: e.target.value })}
                  className="h-9 w-full min-w-0 pointer-coarse:h-11"
                />
              </Label>
              <Label className="col-start-1 flex-col items-start gap-1.5 @min-[650px]/turnos:col-start-auto">
                <span className="text-xs text-muted-foreground">Primera llegada</span>
                <TimeInput className="w-full" label={`Primera llegada, ${s.name} del ${label}`} value={s.from} error={errors[`${p}.from`]} onChange={(v) => onChange(i, { from: v })} />
              </Label>
              <Label className="flex-col items-start gap-1.5">
                <span className="text-xs text-muted-foreground">Última llegada</span>
                <TimeInput
                  className="w-full"
                  label={`Última llegada, ${s.name} del ${label}`}
                  value={s.lastEntry}
                  error={errors[`${p}.lastEntry`]}
                  onChange={(v) => onChange(i, { lastEntry: v })}
                />
              </Label>
              <Label className="col-start-1 flex-col items-start gap-1.5 @min-[650px]/turnos:col-start-auto">
                <span className="text-xs text-muted-foreground">Por franja</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  aria-label={`Máximo de comensales por franja, ${s.name} del ${label}`}
                  placeholder="Sin límite"
                  title="Comensales que pueden llegar en una misma franja de este turno (vacío: el del local)"
                  className="cifra h-9 w-full min-w-0 pointer-coarse:h-11"
                  value={intToInput(s.maxGuestsPerSlot)}
                  aria-invalid={errors[`${p}.maxGuestsPerSlot`] ? true : undefined}
                  onChange={(e) => onChange(i, { maxGuestsPerSlot: shiftLimitFromInput(e.target.value) })}
                />
              </Label>
              <Label className="flex-col items-start gap-1.5">
                <span className="text-xs text-muted-foreground">Por turno</span>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  aria-label={`Máximo de comensales en el turno, ${s.name} del ${label}`}
                  placeholder="Sin límite"
                  title="Comensales en todo el turno (vacío: sin límite)"
                  className="cifra h-9 w-full min-w-0 pointer-coarse:h-11"
                  value={intToInput(s.maxGuestsPerShift)}
                  aria-invalid={errors[`${p}.maxGuestsPerShift`] ? true : undefined}
                  onChange={(e) => onChange(i, { maxGuestsPerShift: shiftLimitFromInput(e.target.value) })}
                />
              </Label>
              <Button variant="ghost" size="icon" className="pointer-coarse:min-w-11 col-start-3 row-start-1 self-end text-muted-foreground @min-[650px]/turnos:col-start-auto @min-[650px]/turnos:row-start-auto" aria-label={`Quitar el turno ${s.name} del ${label}`} onClick={() => onRemove(i)}>
                <XIcon aria-hidden />
              </Button>
            </div>
            {rowErrors.length > 0 ? (
              <p role="alert" className="text-xs text-destructive">
                {rowErrors.join(" ")}
              </p>
            ) : null}
          </div>
        )
      })}
      {errors[path] ? (
        <p role="alert" className="text-xs text-destructive">
          {errors[path]}
        </p>
      ) : null}
      <Button variant="ghost" size="sm" className="self-start text-muted-foreground" onClick={onAdd} disabled={shifts.length >= 6}>
        <PlusIcon aria-hidden />
        Añadir turno
      </Button>
    </div>
  )
}
