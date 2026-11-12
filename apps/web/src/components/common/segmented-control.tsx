"use client"

import type { ReactNode } from "react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/cn"

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  /** Icono Phosphor delante de la palabra (con `aria-hidden`). */
  icon?: ReactNode
  /** Texto más corto para pantallas estrechas («Todo» por «Todo el día»). */
  short?: string
}

/**
 * Elegir una opción de pocas a la vista: Comida / Cena / Todo el día, o la zona del plano.
 * Es el ToggleGroup de shadcn en modo `single`, que nunca se queda sin opción elegida.
 * Necesita `label` (lo lee el lector de pantalla como nombre del grupo).
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onValueChange,
  className,
}: {
  label: string
  options: readonly SegmentedOption<T>[]
  value: T
  onValueChange: (value: T) => void
  className?: string
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        // Pulsar la opción elegida no la desmarca.
        if (next) onValueChange(next as T)
      }}
      variant="outline"
      size="sm"
      className={cn("rounded-lg border bg-surface-sunken/60 p-0.5", className)}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          className="border-0 px-2 text-muted-foreground sm:px-3 transition-[background-color,color,box-shadow] duration-150 ease-(--ease-llenamos) data-[state=on]:bg-surface-raised data-[state=on]:text-foreground data-[state=on]:shadow-soft pointer-coarse:min-h-11"
        >
          {o.icon}
          {o.short ? (
            <>
              <span className="sm:hidden" aria-hidden>
                {o.short}
              </span>
              <span className="max-sm:sr-only">{o.label}</span>
            </>
          ) : (
            o.label
          )}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
