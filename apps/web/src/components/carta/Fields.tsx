"use client"
import { useId, useState } from "react"
import { type MenuText, type Allergen, ALLERGENS, ALLERGEN_LABEL } from "@llenamos/core"
import { TextField } from "@/components/common/form-fields"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { centsFromEuros } from "@/lib/carta/forms"

export function Translation({
  label,
  value,
  onChange,
  maxLength = 80,
}: {
  label: string
  value: MenuText
  onChange: (v: MenuText) => void
  maxLength?: number
}) {
  return (
    <fieldset className="grid gap-3 sm:grid-cols-3">
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      {(["es", "ca", "en"] as const).map((lang) => (
        <TextField
          key={lang}
          label={{ es: "Castellano", ca: "Catalán", en: "Inglés" }[lang]}
          value={value[lang]}
          maxLength={maxLength}
          placeholder={lang === "es" ? "" : "Si está vacío, se usa castellano"}
          onChange={(e) => onChange({ ...value, [lang]: e.target.value })}
        />
      ))}
    </fieldset>
  )
}
export function MoneyField({
  label = "Precio con IVA (€)",
  value,
  onChange,
}: {
  label?: string
  value: number
  onChange: (cents: number) => void
}) {
  const [raw, setRaw] = useState((value / 100).toFixed(2))
  const [error, setError] = useState("")
  return (
    <label className="grid gap-2 text-sm">
      {label}
      <Input
        value={raw}
        inputMode="decimal"
        aria-invalid={!!error}
        onChange={(e) => {
          setRaw(e.target.value)
          try {
            onChange(centsFromEuros(e.target.value))
            setError("")
          } catch (err) {
            onChange(Number.NaN)
            setError((err as Error).message)
          }
        }}
      />
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </label>
  )
}
export function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  disabled?: boolean
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  const id = useId()
  return (
    <label htmlFor={id} className="flex min-h-12 items-center gap-3 text-sm">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} />
      {label}
    </label>
  )
}
export function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 240,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
}) {
  return (
    <TextField
      label={label}
      type="number"
      min={min}
      max={max}
      step={1}
      value={Number.isNaN(value) ? "" : value}
      onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))}
    />
  )
}
export function AllergenFields({
  label,
  value,
  onChange,
}: {
  label: string
  value: Allergen[]
  onChange: (v: Allergen[]) => void
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      <div className="grid grid-cols-2 gap-x-3 sm:grid-cols-4">
        {ALLERGENS.map((a) => (
          <Toggle
            key={a}
            label={ALLERGEN_LABEL.es[a]}
            checked={value.includes(a)}
            onChange={(v) => onChange(v ? [...value, a] : value.filter((x) => x !== a))}
          />
        ))}
      </div>
    </fieldset>
  )
}
