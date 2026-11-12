"use client"

import { SelectField } from "./form-fields"

const HORAS = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`)

/** Horas de pared cada cuarto de hora. Conserva también la hora actual si cae entre dos opciones. */
export function TimeSelectField({ label, value, onChange, error }: {
  label: string
  value: string
  onChange: (value: string) => void
  error?: string
}) {
  const options = value && !HORAS.includes(value) ? [...HORAS, value].sort() : HORAS
  return (
    <SelectField label={label} value={value} onChange={(e) => onChange(e.target.value)} error={error} className="cifra">
      <option value="">Elige una hora</option>
      {options.map((hora) => <option key={hora} value={hora}>{hora}</option>)}
    </SelectField>
  )
}
