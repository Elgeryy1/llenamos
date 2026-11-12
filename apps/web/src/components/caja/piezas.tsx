"use client"

import { useState, type FormEvent, type ReactNode } from "react"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { TextField, SelectField } from "@/components/common/form-fields"
import type { Lectura } from "@/lib/caja/datos"
import { errorCaja } from "@/lib/caja/api"
import { centimos } from "@/lib/caja/modelo"
import type { OperacionCaja } from "@/lib/caja/useOperacion"

export function AvisoFiscal() {
  return (
    <Notice tone="warning" title="Proveedor de prueba: no válido para Hacienda">
      No se envía nada a Hacienda. Esta caja solo sirve para pruebas locales.
    </Notice>
  )
}
export function LecturaCaja<T>({
  live,
  label,
  children,
}: {
  live: Lectura<T>
  label: string
  children: (data: T[], fresh: boolean) => ReactNode
}) {
  if (live.status === "loading")
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Cargando {label}…
      </p>
    )
  if (live.status === "error")
    return (
      <Notice tone="error" title={`No se pueden leer ${label}`}>
        {errorCaja(live.error)}
      </Notice>
    )
  return (
    <>
      {!live.fresh ? (
        <Notice tone="warning">
          Datos sin confirmar por el servidor. Las operaciones están bloqueadas
          hasta recuperar la conexión.
        </Notice>
      ) : null}
      {children(live.data, live.fresh)}
    </>
  )
}
export function Accion({
  children,
  onClick,
  disabled,
  primary = false,
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  primary?: boolean
}) {
  return (
    <Button
      type="button"
      variant={primary ? "default" : "outline"}
      className="min-h-12 max-w-full whitespace-normal px-4"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}
export function Campo({
  label,
  value,
  onChange,
  money = false,
  hint,
  required = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  money?: boolean
  hint?: string
  required?: boolean
}) {
  return (
    <TextField
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      inputMode={money ? "decimal" : undefined}
      className="h-12"
      hint={hint}
      required={required}
      autoComplete="off"
    />
  )
}
export function Selector({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  return (
    <SelectField
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      touchSize={48}
      className="min-h-12"
      disabled={disabled}
    >
      <option value="">Elige una opción</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </SelectField>
  )
}
export function Formulario({
  children,
  onSubmit,
  label,
  disabled,
}: {
  children: ReactNode
  onSubmit: () => Promise<unknown> | unknown
  label: string
  disabled?: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await onSubmit()
    } catch (e) {
      setError(errorCaja(e))
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset disabled={disabled} className="space-y-4">
        {children}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button
          type="submit"
          variant="outline"
          className="min-h-12 w-full whitespace-normal"
        >
          {label}
        </Button>
      </fieldset>
    </form>
  )
}
export function Bloque({
  title,
  children,
}: {
  title: ReactNode
  children: ReactNode
}) {
  return (
    <section className="superficie min-w-0 overflow-hidden">
      <h2 className="border-b px-5 py-4 text-lg font-semibold">{title}</h2>
      <div className="space-y-4 p-4 sm:p-5">{children}</div>
    </section>
  )
}
export function ResultadoOperacion({ op }: { op: OperacionCaja }) {
  return (
    <div className="space-y-3" aria-live="polite">
      {op.error ? <Notice tone="error">{op.error}</Notice> : null}
      {op.pending ? (
        <Notice
          tone="warning"
          title="Operación sin confirmar"
          action={
            <Accion disabled={op.busy} onClick={() => void op.retry()}>
              {op.busy ? "Consultando…" : "Recuperar la misma operación"}
            </Accion>
          }
        >
          No vuelvas a cobrar por otra vía hasta recuperar la respuesta. Se
          conserva el mismo identificador incluso al recargar esta pestaña.
          <span className="block text-xs">Operación: {op.pendingName}</span>
        </Notice>
      ) : null}
      {op.message ? (
        <Notice title="Respuesta del servidor">{op.message}</Notice>
      ) : null}
    </div>
  )
}
export function importe(value: string, positive = false) {
  const n = centimos(value)
  if (positive && n === 0)
    throw new Error("El importe debe ser mayor que cero.")
  return n
}
