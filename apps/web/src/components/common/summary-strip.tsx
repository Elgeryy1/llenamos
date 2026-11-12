import type { ReactNode } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/cn"

/** Cifras relacionadas dentro de una superficie, con separadores en vez de tarjetas. */
export function SummaryStrip({ label, items, className }: {
  label: string
  items: Array<{ label: string; value: ReactNode; hint?: ReactNode; loading?: boolean; tone?: "success" | "warning" | "destructive" }>
  className?: string
}) {
  return (
    <dl aria-label={label} className={cn("superficie grid grid-cols-2 overflow-hidden sm:flex sm:divide-x", className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0 flex-1 border-b px-4 py-5 odd:border-r sm:border-0 sm:px-6">
          <dt className="text-sm text-muted-foreground">{item.label}</dt>
          <dd
            className={cn(
              "cifra mt-2 text-4xl leading-none font-semibold sm:text-[42px]",
              item.tone === "success" && "text-success",
              item.tone === "warning" && "text-warning",
              item.tone === "destructive" && "text-destructive",
            )}
          >
            {item.loading ? <Skeleton className="h-10 w-16" /> : item.value}
          </dd>
          {item.hint ? <dd className="mt-2 text-xs text-muted-foreground">{item.hint}</dd> : null}
        </div>
      ))}
    </dl>
  )
}
