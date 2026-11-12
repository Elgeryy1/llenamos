import type { ReactNode } from "react"
import { Card, CardAction, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/cn"

/**
 * Cifra con su etiqueta, del bloque dashboard-01 de shadcn (section-cards), sin el
 * degradado. La cifra va en Geist Mono. `tone` la colorea solo cuando dice un estado:
 * `success` para «sentados», `warning` para lo que pide atención.
 */
export function StatCard({
  label,
  value,
  hint,
  action,
  tone,
  loading,
  className,
}: {
  label: string
  value: ReactNode
  /** Línea de abajo, en apagado («en 9 de 16 mesas»). */
  hint?: ReactNode
  /** Algo pequeño arriba a la derecha (un Tag, un enlace). */
  action?: ReactNode
  tone?: "success" | "warning" | "destructive"
  loading?: boolean
  className?: string
}) {
  return (
    <Card size="sm" className={cn("@container/card gap-2", className)}>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={cn(
            // La Card pequeña pone su título en text-sm con group-data; la cifra lo pisa igual.
            "cifra text-2xl font-medium group-data-[size=sm]/card:text-2xl",
            tone === "success" && "text-success",
            tone === "warning" && "text-warning",
            tone === "destructive" && "text-destructive",
          )}
        >
          {loading ? <Skeleton className="mt-1 h-7 w-16" /> : value}
        </CardTitle>
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      {hint ? <CardFooter className="border-t-0 bg-transparent pt-0 text-xs text-muted-foreground">{hint}</CardFooter> : null}
    </Card>
  )
}

/** Rejilla de StatCard: una columna en el móvil, dos en tablet, cuatro en escritorio. */
export function StatGrid({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4", className)}>{children}</div>
}
