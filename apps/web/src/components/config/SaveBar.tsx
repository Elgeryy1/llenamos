"use client"

import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/cn"

/**
 * Barra fija al pie con los cambios sin guardar: lleva el único botón ámbar de la
 * pantalla. Solo aparece cuando hay algo que guardar.
 */
export function SaveBar({
  dirty,
  pending,
  message,
  saveLabel = "Guardar cambios",
  onSave,
  onDiscard,
  disabled,
  className,
}: {
  dirty: boolean
  pending: boolean
  message: ReactNode
  saveLabel?: string
  onSave: () => void
  onDiscard: () => void
  disabled?: boolean
  className?: string
}) {
  if (!dirty && !pending) return null
  return (
    <div
      role="region"
      aria-label="Cambios sin guardar"
      className={cn(
        "sticky bottom-0 z-10 -mx-4 mt-6 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6",
        className,
      )}
    >
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {message}
      </p>
      <div className="flex gap-2">
        <Button size="lg" variant="ghost" onClick={onDiscard} disabled={pending}>
          Descartar
        </Button>
        <Button size="lg" onClick={onSave} disabled={disabled || pending}>
          {pending ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
          {pending ? "Guardando…" : saveLabel}
        </Button>
      </div>
    </div>
  )
}
