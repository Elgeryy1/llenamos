"use client"

import Link from "next/link"
import { useRef, useState, type ReactNode } from "react"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { errorSala } from "@/lib/comandero/callables"
import type { Live } from "@/lib/firebase/live"

export function EnlacesServicio() {
  return (
    <nav aria-label="Servicio de sala" className="mb-5 flex flex-wrap gap-2">
      {[
        ["/panel/sala", "Plano de sala"],
        ["/panel/comandero", "Comandero"],
        ["/panel/comandas", "Todas las comandas"],
        ["/panel/para-llevar", "Para llevar"],
      ].map(([href, label]) => (
        <Button key={href} asChild variant="outline" className="h-12">
          <Link href={href!}>{label}</Link>
        </Button>
      ))}
    </nav>
  )
}

export function EstadoLectura<T>({
  live,
  label,
  children,
}: {
  live: Live<T>
  label: string
  children: (data: T) => ReactNode
}) {
  if (live.status === "loading")
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Cargando {label}…
      </p>
    )
  if (live.status === "error")
    return (
      <Notice tone="error" title={`No hemos podido leer ${label}`}>
        {errorSala(live.error)} Si falta el servidor de sala, sus datos tampoco
        están disponibles.
      </Notice>
    )
  return <>{children(live.data)}</>
}

/** Una sola escritura en vuelo: nunca enseña éxito antes de recibir y validar la salida. */
export function useOperacion() {
  const lock = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function run(action: () => Promise<string | void>): Promise<boolean> {
    if (lock.current) return false
    lock.current = true
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await action()
      setMessage(result ?? "Operación confirmada por el servidor.")
      return true
    } catch (e) {
      setError(errorSala(e))
      return false
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return {
    busy,
    run,
    feedback: (
      <>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {message ? <Notice tone="success">{message}</Notice> : null}
      </>
    ),
  }
}
