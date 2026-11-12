"use client"

import type { ReactNode } from "react"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import type { Live } from "@/lib/api/live"
import { mensajeError } from "@/lib/fidelizacion/api"

export function Datos<T>({ live, children, recargar }: { live: Live<T>; children: (data: T) => ReactNode; recargar?: () => void }) {
  if (live.status === "loading") return <LoadingBlock label="Consultando fidelización…" />
  if (live.status === "error") return <Notice tone="error" title="No se han podido consultar los datos" action={recargar ? <Button variant="outline" onClick={recargar}>Volver a consultar</Button> : undefined}>{mensajeError(live.error)}</Notice>
  return <>{children(live.data)}</>
}
export function Bloque({ titulo, children, extra }: { titulo: string; children: ReactNode; extra?: ReactNode }) {
  return <section className="superficie overflow-hidden"><header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4"><h2 className="text-base font-semibold">{titulo}</h2>{extra}</header><div className="space-y-4 p-5">{children}</div></section>
}
export function Resultado({ mensaje, error }: { mensaje?: string | null; error?: string | null }) {
  if (error) return <Notice tone="error">{error}</Notice>
  if (mensaje) return <Notice>{mensaje}</Notice>
  return null
}
