import { Skeleton } from "@/components/ui/skeleton"

/** Lo que se ve mientras llega el restaurante: la forma de la página, sin textos. */
export function CargandoPublica({ compact = false }: { compact?: boolean }) {
  return (
    <div aria-busy="true" className="mx-auto flex w-full max-w-[640px] flex-col gap-5 px-4 pt-5 sm:px-6 sm:pt-8">
      <div className="flex items-center justify-between">
        <Skeleton className="size-9 rounded-lg" />
        <Skeleton className="h-8 w-28" />
      </div>
      <Skeleton className={compact ? "h-7 w-3/4" : "h-9 w-2/3"} />
      <div className="grid grid-cols-4 gap-2">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-12 rounded-xl" />
        ))}
      </div>
      <div className="flex gap-2 overflow-hidden">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[66px] w-[62px] shrink-0 rounded-xl" />
        ))}
      </div>
    </div>
  )
}
