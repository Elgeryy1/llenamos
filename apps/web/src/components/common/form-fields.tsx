"use client"

import { useId, type ReactNode } from "react"
import type * as React from "react"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Desplegable } from "@/components/common/desplegable"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/cn"

/*
 * Atajos sobre el Field de shadcn: etiqueta, control, ayuda y error ya enlazados
 * (htmlFor, aria-invalid, aria-describedby). Con error, la ayuda deja sitio al error,
 * que se anuncia al momento (role="alert"). Para algo distinto, monta Field a mano.
 */

interface ShellProps {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  /** Clases del Field (ancho, columnas). `className` va al control. */
  fieldClassName?: string
}

function useIds(error?: string | null, hint?: ReactNode) {
  const id = useId()
  return { id, describedBy: error ? `${id}-error` : hint ? `${id}-hint` : undefined }
}

function Shell({ id, label, hint, error, fieldClassName, children }: ShellProps & { id: string; children: ReactNode }) {
  return (
    <Field data-invalid={error ? true : undefined} className={fieldClassName}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children}
      {error ? (
        <FieldError id={`${id}-error`}>{error}</FieldError>
      ) : hint ? (
        <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
      ) : null}
    </Field>
  )
}

export interface TextFieldProps extends Omit<React.ComponentProps<typeof Input>, "id">, ShellProps {
  /** Botón o icono dentro del borde, a la derecha (ver contraseña, generar). */
  trailing?: ReactNode
}

export function TextField({ label, hint, error, fieldClassName, trailing, className, ...rest }: TextFieldProps) {
  const { id, describedBy } = useIds(error, hint)
  return (
    <Shell id={id} label={label} hint={hint} error={error} fieldClassName={fieldClassName}>
      <div className="relative">
        <Input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn("h-9 pointer-coarse:h-11", trailing && "pr-11", className)}
          {...rest}
        />
        {trailing ? <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div> : null}
      </div>
    </Shell>
  )
}

export interface TextareaFieldProps extends Omit<React.ComponentProps<typeof Textarea>, "id">, ShellProps {}

export function TextareaField({ label, hint, error, fieldClassName, ...rest }: TextareaFieldProps) {
  const { id, describedBy } = useIds(error, hint)
  return (
    <Shell id={id} label={label} hint={hint} error={error} fieldClassName={fieldClassName}>
      <Textarea id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
    </Shell>
  )
}

export interface SelectFieldProps extends Omit<React.ComponentProps<typeof Desplegable>, "id">, ShellProps {}

/** Desplegable propio (Select de shadcn sobre Radix, ver `desplegable.tsx`) con etiqueta, ayuda y error. */
export function SelectField({ label, hint, error, fieldClassName, className, children, ...rest }: SelectFieldProps) {
  const { id, describedBy } = useIds(error, hint)
  return (
    <Shell id={id} label={label} hint={hint} error={error} fieldClassName={fieldClassName}>
      <Desplegable
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn("h-9", className)}
        {...rest}
      >
        {children}
      </Desplegable>
    </Shell>
  )
}
