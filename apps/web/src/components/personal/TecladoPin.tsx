"use client"

import { BackspaceIcon } from "@phosphor-icons/react"
import { cn } from "@/lib/cn"
import { Button } from "@/components/ui/button"

const TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const

/**
 * Teclado numérico grande para el PIN del puesto de fichaje. Cada tecla mide 64 px. Los puntos
 * enseñan cuántas cifras van, nunca cuáles. También acepta el teclado físico.
 */
export function TecladoPin({ valor, onChange, max = 6, min = 4, disabled, onEnter }: {
  valor: string
  onChange: (v: string) => void
  max?: number
  min?: number
  disabled?: boolean
  onEnter?: () => void
}) {
  const poner = (c: string) => { if (!disabled && valor.length < max) onChange(valor + c) }
  const borrar = () => { if (!disabled) onChange(valor.slice(0, -1)) }
  return (
    <div
      className="mx-auto w-full max-w-72 space-y-4"
      role="group"
      aria-label="Teclado del PIN"
      onKeyDown={(e) => {
        if (/^\d$/.test(e.key)) { e.preventDefault(); poner(e.key) }
        else if (e.key === "Backspace") { e.preventDefault(); borrar() }
        else if (e.key === "Enter" && valor.length >= min) onEnter?.()
      }}
    >
      <p className="flex justify-center gap-3" role="img" aria-label={`${valor.length} de ${max} cifras escritas`}>
        {Array.from({ length: max }, (_, i) => (
          <span key={i} aria-hidden className={cn("size-3.5 rounded-full border transition-colors duration-150", i < valor.length ? "border-primary bg-primary" : "border-ash bg-transparent", i >= min && i >= valor.length && "opacity-50")} />
        ))}
      </p>
      <div className="grid grid-cols-3 gap-3">
        {TECLAS.map((t) => (
          <Button key={t} type="button" variant="outline" disabled={disabled} className="h-16 text-2xl font-medium shadow-soft" onClick={() => poner(t)}>
            <span className="cifra">{t}</span>
          </Button>
        ))}
        <span aria-hidden />
        <Button type="button" variant="outline" disabled={disabled} className="h-16 text-2xl font-medium shadow-soft" onClick={() => poner("0")}>
          <span className="cifra">0</span>
        </Button>
        <Button type="button" variant="ghost" disabled={disabled || valor.length === 0} className="h-16" aria-label="Borrar la última cifra" onClick={borrar}>
          <BackspaceIcon aria-hidden className="size-6" />
        </Button>
      </div>
    </div>
  )
}
