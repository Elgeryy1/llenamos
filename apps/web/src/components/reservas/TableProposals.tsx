"use client"

import type { TableProposals as Proposals } from "@llenamos/core"
import { CheckCircleIcon } from "@phosphor-icons/react"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { Tag } from "@/components/common/tag"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/cn"
import type { ErrorInfo } from "@/lib/firebase/errors"

const key = (ids: readonly string[]) => [...ids].sort().join("+")

/**
 * Propuestas de mesa del motor (`proponerMesasReserva`), de mejor a peor, con su
 * explicación. Se elige una; la decisión es de quien gestiona la sala.
 */
export function TableProposalPicker({
  state,
  selected,
  onSelect,
  current,
  name = "mesas",
}: {
  state: { status: "idle" } | { status: "loading" } | { status: "error"; error: ErrorInfo } | { status: "ready"; data: Proposals }
  selected: readonly string[] | null
  onSelect: (tableIds: string[]) => void
  /** Mesas que ya tiene la reserva, para marcarlas. */
  current?: readonly string[]
  name?: string
}) {
  if (state.status === "idle") return null
  if (state.status === "loading") {
    return (
      <LoadingBlock label="Buscando mesas libres…" className="flex flex-col gap-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </LoadingBlock>
    )
  }
  if (state.status === "error") {
    return (
      <Notice tone="error" title="No se han podido calcular las mesas" detail={state.error.code}>
        {state.error.message}
      </Notice>
    )
  }
  const { data } = state
  const currentKey = current && current.length > 0 ? key(current) : null
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-soft-foreground">{data.summary}</p>
      {data.proposals.length === 0 ? null : (
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Mesas propuestas</legend>
          {data.proposals.map((p, i) => {
            const k = key(p.tableIds)
            const checked = selected !== null && key(selected) === k
            return (
              <label
                key={k}
                className={cn(
                  "flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors hover:bg-muted has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                  checked && "border-primary/60 bg-primary/5",
                )}
              >
                <input
                  type="radio"
                  name={name}
                  className="mt-1 size-4 accent-primary"
                  checked={checked}
                  onChange={() => onSelect([...p.tableIds])}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="cifra font-medium">{p.tableNames.join(" + ")}</span>
                    <span className="cifra text-xs text-muted-foreground">
                      {p.seats} plazas{p.spare > 0 ? `, sobran ${p.spare}` : ""}
                    </span>
                    {i === 0 ? <Tag tone="habitual">Recomendada</Tag> : null}
                    {k === currentKey ? (
                      <span className="inline-flex items-center gap-1 text-xs text-success">
                        <CheckCircleIcon aria-hidden /> La que tiene
                      </span>
                    ) : null}
                  </span>
                  <span className="text-sm text-muted-foreground">{p.explanation}</span>
                </span>
              </label>
            )
          })}
        </fieldset>
      )}
      {data.discards.length > 0 ? (
        <details className="rounded-lg border px-3 py-2 text-sm">
          <summary className="cursor-pointer text-muted-foreground">Por qué no salen otras mesas ({data.discards.length})</summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {data.discards.map((d) => (
              <li key={key(d.tableIds)} className="flex gap-2">
                <span className="cifra shrink-0 font-medium">{d.tableNames.join(" + ")}</span>
                <span className="text-muted-foreground">{d.explanation}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}
