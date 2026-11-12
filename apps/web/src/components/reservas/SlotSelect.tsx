"use client"

import { SelectField } from "@/components/common/form-fields"
import type { StaffAvailability } from "@/lib/reservas/disponibilidad"

/**
 * Horas del día con su disponibilidad. Las ocupadas salen desactivadas con el motivo,
 * para que se vea por qué no se puede. `extra` añade una hora fuera de turno ya elegida.
 */
export function SlotSelect({
  availability,
  value,
  onChange,
  error,
  extra,
  label = "Hora",
}: {
  availability: StaffAvailability | null
  value: string
  onChange: (time: string) => void
  error?: string | null
  extra?: string | null
  label?: string
}) {
  const slots = availability?.slots ?? []
  const free = slots.filter((s) => s.available).length
  const shifts = [...new Set(slots.map((s) => s.shift))]
  const hint = !availability
    ? "Cargando las horas…"
    : !availability.open
      ? (availability.message ?? "El local no abre ese día.")
      : free === 0
        ? "No queda ninguna hora libre para ese grupo."
        : `${free} ${free === 1 ? "hora libre" : "horas libres"}. Duración prevista: ${availability.durationMinutes} min.`
  return (
    <SelectField label={label} value={value} onChange={(e) => onChange(e.target.value)} error={error} hint={hint} disabled={!availability}>
      <option value="">Elige una hora</option>
      {extra && !slots.some((s) => s.time === extra) ? <option value={extra}>{extra} (fuera de turno)</option> : null}
      {shifts.map((shift) => (
        <optgroup key={shift} label={shift}>
          {slots
            .filter((s) => s.shift === shift)
            .map((s) => (
              <option key={s.startAt} value={s.time} disabled={!s.available}>
                {s.available ? s.time : `${s.time} · ${s.reason ?? "no disponible"}`}
              </option>
            ))}
        </optgroup>
      ))}
    </SelectField>
  )
}
