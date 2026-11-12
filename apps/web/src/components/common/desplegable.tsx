"use client"

import * as React from "react"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/cn"

/**
 * Desplegable propio con la misma forma de uso que un selector HTML: recibe `<option>` y
 * `<optgroup>` como hijos y avisa con `onChange(e)` (`e.target.value`). Así se cambia el
 * menú que pinta el navegador (claro e ilegible en Windows) por uno con el tema del panel
 * sin tocar cada pantalla. La opción con `value=""` hace de texto de ayuda.
 */
export type DesplegableProps = Omit<React.ComponentProps<"select">, "size" | "onChange" | "value" | "defaultValue"> & {
  value?: string | number
  defaultValue?: string | number
  onChange?: (event: { target: { value: string; name?: string }; currentTarget: { value: string; name?: string } }) => void
  size?: "sm" | "default"
  /** Objetivo táctil también en el menú, que se pinta fuera de la página mediante un portal. */
  touchSize?: 44 | 48
}

interface Opcion {
  value: string
  label: React.ReactNode
  disabled: boolean
}

interface Grupo {
  label: string | null
  options: Opcion[]
}

type OptionProps = { value?: string | number; disabled?: boolean; children?: React.ReactNode }
type OptgroupProps = { label?: string; disabled?: boolean; children?: React.ReactNode }

/** Lee los `<option>` y `<optgroup>` de los hijos, también dentro de fragmentos y listas. */
export function leerOpciones(children: React.ReactNode): Grupo[] {
  const grupos: Grupo[] = []
  let suelto: Grupo | null = null
  const opcion = (props: OptionProps, disabled = false): Opcion => ({
    value: String(props.value ?? textoDe(props.children)),
    label: props.children,
    disabled: Boolean(props.disabled) || disabled,
  })
  const recorrer = (nodo: React.ReactNode) => {
    React.Children.forEach(nodo, (hijo) => {
      if (!React.isValidElement(hijo)) return
      if (hijo.type === React.Fragment) return recorrer((hijo.props as { children?: React.ReactNode }).children)
      if (hijo.type === "optgroup") {
        const props = hijo.props as OptgroupProps
        const options: Opcion[] = []
        React.Children.forEach(props.children, (o) => {
          if (React.isValidElement(o) && o.type === "option") options.push(opcion(o.props as OptionProps, props.disabled))
        })
        grupos.push({ label: props.label ?? null, options })
        suelto = null
        return
      }
      if (hijo.type === "option") {
        if (!suelto) {
          suelto = { label: null, options: [] }
          grupos.push(suelto)
        }
        suelto.options.push(opcion(hijo.props as OptionProps))
      }
    })
  }
  recorrer(children)
  return grupos
}

function textoDe(nodo: React.ReactNode): string {
  if (nodo == null || typeof nodo === "boolean") return ""
  if (typeof nodo === "string" || typeof nodo === "number") return String(nodo)
  if (Array.isArray(nodo)) return nodo.map(textoDe).join("")
  if (React.isValidElement(nodo)) return textoDe((nodo.props as { children?: React.ReactNode }).children)
  return ""
}

export function Desplegable({
  value,
  defaultValue,
  onChange,
  children,
  disabled,
  name,
  required,
  className,
  size = "default",
  id,
  touchSize = 44,
  ...rest
}: DesplegableProps) {
  const grupos = React.useMemo(() => leerOpciones(children), [children])
  const todas = grupos.flatMap((g) => g.options)
  const ayuda = todas.find((o) => o.value === "")
  const [interno, setInterno] = React.useState(String(defaultValue ?? ""))
  const actual = value !== undefined ? String(value) : interno

  const elegir = (v: string) => {
    if (value === undefined) setInterno(v)
    const target = { value: v, name }
    onChange?.({ target, currentTarget: target })
  }

  return (
    <Select value={actual} onValueChange={elegir} disabled={disabled} name={name} required={required}>
      <SelectTrigger
        id={id}
        size={size}
        aria-label={rest["aria-label"]}
        aria-invalid={rest["aria-invalid"]}
        aria-describedby={rest["aria-describedby"]}
        className={cn("w-full min-w-0", touchSize === 48 ? "min-h-12 text-base" : "pointer-coarse:h-11", className)}
      >
        <SelectValue placeholder={ayuda ? ayuda.label : undefined} />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-80">
        {grupos.map((g, i) => {
          // La opción vacía solo hace de texto de ayuda en el botón.
          const items = g.options
            .filter((o) => o.value !== "")
            .map((o) => (
              <SelectItem key={o.value} value={o.value} disabled={o.disabled} className={touchSize === 48 ? "min-h-12 text-base" : "pointer-coarse:min-h-11"}>
                {o.label}
              </SelectItem>
            ))
          if (items.length === 0) return null
          return (
            <SelectGroup key={g.label ?? `suelto-${i}`}>
              {g.label ? <SelectLabel>{g.label}</SelectLabel> : null}
              {items}
            </SelectGroup>
          )
        })}
      </SelectContent>
    </Select>
  )
}
