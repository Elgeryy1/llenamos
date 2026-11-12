"use client"

import type { ReactNode } from "react"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import type { Live } from "@/lib/api/live"
import { errorAnalisis } from "@/lib/analisis/api"
import type { useAccion } from "@/lib/analisis/datos"

export function Resultado<T>({ live, children }: { live: Live<T>; children: (data: T) => ReactNode }) {
  if (live.status === "loading") return <LoadingBlock label="Consultando los datos…" />
  if (live.status === "error") return <Notice tone="error" title="No se pueden consultar los datos">{errorAnalisis(live.error)}</Notice>
  return <>{children(live.data)}</>
}
export function EstadoAccion({ accion }: { accion: ReturnType<typeof useAccion> }) {
  return <>{accion.error ? <Notice tone="error">{errorAnalisis(accion.error)}</Notice> : null}{accion.message ? <Notice tone="success">{accion.message}</Notice> : null}</>
}
export function Bloque({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="superficie min-w-0 overflow-hidden"><div className="border-b p-4 sm:px-5"><h2 className="text-base font-semibold">{title}</h2>{description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}</div><div className="p-4 sm:p-5">{children}</div></section>
}

/** SVG propio. La tabla adjunta permite consultar todos los valores con teclado o lector. */
export function Grafica({ label, rows, money = false }: { label: string; rows: { label: string; value: number; secondary?: number }[]; money?: boolean }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No hay datos en este periodo.</p>
  const max = Math.max(1, ...rows.flatMap((r) => [r.value, r.secondary ?? 0]))
  const w = 660, h = 190, step = 600 / rows.length
  const zero = 155
  const y = (v: number) => zero - v / max * 130
  return <figure><svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="w-full text-primary">
    {[0, 0.5, 1].map((n) => <g key={n}><line x1="42" x2="650" y1={y(max * n)} y2={y(max * n)} className="stroke-border" /><text x="36" y={y(max * n) + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">{Math.round(max * n / (money ? 100 : 1))}</text></g>)}
    {rows.map((r, i) => <g key={`${r.label}:${i}`}><title>{`${r.label}: ${r.value}${r.secondary === undefined ? "" : `, reservado: ${r.secondary}`}`}</title><rect x={46 + i * step} y={y(r.value)} width={Math.max(1, step * 0.65)} height={zero - y(r.value)} rx="3" fill="currentColor" opacity="0.8" />{r.secondary === undefined ? null : <rect x={46 + i * step} y={y(r.secondary)} width={Math.max(1, step * 0.28)} height={zero - y(r.secondary)} rx="2" className="fill-success" />}{(rows.length < 10 || i % Math.ceil(rows.length / 7) === 0) ? <text x={46 + i * step} y="178" className="fill-muted-foreground text-[10px]">{r.label}</text> : null}</g>)}
  </svg><figcaption className="text-xs text-muted-foreground">{money ? "Importes en euros." : "Comensales por tramo."} {rows.some((r) => r.secondary !== undefined) ? "Ámbar: previsión final. Verde: ya reservado." : ""}</figcaption></figure>
}
