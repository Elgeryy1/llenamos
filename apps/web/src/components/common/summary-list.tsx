import type { ReactNode } from "react"
import { cn } from "@/lib/cn"

/** Lista de datos en dos columnas (referencia, día, hora…), para una ficha con superficie cálida. */
export function SummaryList({ items }: { items: Array<{ label: string; value: ReactNode; mono?: boolean; wide?: boolean }> }) {
  return (
    <dl className="grid min-w-0 grid-cols-2 border-t">
      {items.map((item, i) => (
        <div
          key={item.label}
          className={cn("min-w-0 border-b px-4 py-4", item.wide ? "col-span-2" : i % 2 === 0 && !items[i + 1]?.wide ? "border-r" : "")}
        >
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className={cn("mt-1 text-sm font-medium wrap-anywhere text-soft-foreground", item.mono && "cifra")}>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
