import type { ReactNode } from "react"
import { Skeleton } from "@/components/ui/skeleton"

/** Zona que está cargando, anunciada a los lectores de pantalla. Dentro, Skeleton de shadcn. */
export function LoadingBlock({ label = "Cargando…", className, children }: { label?: string; className?: string; children?: ReactNode }) {
  return (
    <div role="status" aria-live="polite" className={className}>
      <span className="sr-only">{label}</span>
      {children ?? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      )}
    </div>
  )
}

/** «En directo · 20:42»: los datos llegan solos. El punto no se anima. */
export function LiveIndicator({ label = "En directo", time }: { label?: string; time?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
      <span aria-hidden className="size-1.5 rounded-full bg-success" />
      {label}
      {time ? <span className="cifra">· {time}</span> : null}
    </span>
  )
}
