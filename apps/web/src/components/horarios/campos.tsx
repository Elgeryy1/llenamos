"use client"

import { useId, type ReactNode } from "react"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/cn"
import { intToInput, normalizeTimeInput } from "@/lib/horarios/form"

/** Campo numérico entero con su unidad («min», «días», «personas»). Vacío = null si `optional`. */
export function NumberField({
  label,
  value,
  onChange,
  unit,
  hint,
  error,
  min,
  max,
  optional,
  placeholder,
  className,
}: {
  label: ReactNode
  value: number | null | undefined
  onChange: (text: string) => void
  unit?: string
  hint?: ReactNode
  error?: string
  min?: number
  max?: number
  optional?: boolean
  placeholder?: string
  className?: string
}) {
  const id = useId()
  const describedBy = error ? `${id}-e` : hint ? `${id}-h` : undefined
  return (
    <Field data-invalid={error ? true : undefined} className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          required={!optional}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className="cifra h-9 w-24 pointer-coarse:h-11"
          value={intToInput(value)}
          onChange={(e) => onChange(e.target.value)}
        />
        {unit ? <span className="text-sm text-muted-foreground">{unit}</span> : null}
      </div>
      {error ? <FieldError id={`${id}-e`}>{error}</FieldError> : hint ? <FieldDescription id={`${id}-h`}>{hint}</FieldDescription> : null}
    </Field>
  )
}

/** Interruptor con su explicación al lado. */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  className,
}: {
  label: ReactNode
  description?: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  className?: string
}) {
  const id = useId()
  return (
    <div className={cn("flex min-h-11 items-center justify-between gap-4", className)}>
      <Label htmlFor={id} className="flex min-h-11 flex-1 flex-col items-start justify-center gap-0.5 leading-snug">
        <span>{label}</span>
        {description ? <span className="text-sm font-normal text-muted-foreground">{description}</span> : null}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </div>
  )
}

/**
 * Hora de pared («13:30»), siempre en 24 horas y en Geist Mono. Se escribe a mano
 * («930» o «9:30» valen) y se pone en limpio al salir del campo.
 */
export function TimeInput({
  label,
  value,
  onChange,
  error,
  disabled,
  className,
  id,
}: {
  label?: string
  value: string
  onChange: (v: string) => void
  error?: string
  disabled?: boolean
  className?: string
  id?: string
}) {
  return (
    <Input
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      maxLength={5}
      placeholder="13:30"
      aria-label={label}
      aria-invalid={error ? true : undefined}
      title={error}
      disabled={disabled}
      className={cn("cifra h-9 w-20 text-center pointer-coarse:h-11", className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => {
        const clean = normalizeTimeInput(e.target.value)
        if (clean !== e.target.value) onChange(clean)
      }}
    />
  )
}
