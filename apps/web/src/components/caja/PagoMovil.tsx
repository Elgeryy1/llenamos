"use client"

import { useState } from "react"
import type { Bill, BillPart, CallableOutput } from "@llenamos/core"
import type { ConId } from "@/lib/caja/datos"
import type { OperacionCaja } from "@/lib/caja/useOperacion"
import { euros } from "@/lib/caja/modelo"
import { Notice } from "@/components/common/notice"
import { Accion, Selector } from "./piezas"

export function PagoMovil({ bill, billId, parts, op, fresh }: {
  bill: Bill; billId: string; parts: ConId<BillPart>[]; op: OperacionCaja; fresh: boolean
}) {
  const [partId, setPart] = useState(parts.find(p => p.totalCents > p.paidCents)?.id ?? "")
  const [requestedPart, setRequestedPart] = useState(partId)
  const [link, setLink] = useState<CallableOutput<"crearEnlaceCobro"> | null>(null)
  const part = parts.find(p => p.id === partId)
  const recovered = op.result?.name === "crearEnlaceCobro" ? op.result.data as CallableOutput<"crearEnlaceCobro"> : null
  const current = requestedPart === partId ? link ?? recovered : null
  return <div className="space-y-3 border-b pb-5">
    <h3 className="font-semibold">Cobrar desde el móvil del cliente</h3>
    <Selector label="Parte para el enlace móvil" value={partId} onChange={v => { setPart(v); setLink(null) }} options={parts.map(p => ({ value: p.id, label: `${p.label} · ${euros(p.totalCents - p.paidCents)} pendiente` }))} />
    <Accion disabled={op.blocked || !fresh || bill.status !== "locked" || !part || part.paidCents >= part.totalCents}
      onClick={() => { setRequestedPart(partId); void op.run("crearEnlaceCobro", { billId, partId, expectedRevision: bill.revision }, () => "Enlace privado creado. Todavía no se ha cobrado nada.").then(r => { if (r) setLink(r) }) }}>
      Crear enlace privado de pago
    </Accion>
    {current ? <Notice title="Enlace privado de esta parte">
      <a className="inline-flex min-h-12 items-center underline" href={current.path} target="_blank" rel="noreferrer">Abrir cuenta del cliente</a>
      <Accion disabled={op.blocked} onClick={() => { void op.run("cancelarCobroMovil", { checkoutId: current.checkoutId, reason: "Enlace cancelado por el personal" }, () => "Enlace cancelado. La parte vuelve a estar libre para cobrar.").then(r => { if (r) setLink(null) }) }}>Cancelar este enlace</Accion>
      <p>Compártelo solo con quien paga esta parte. Caduca a los 15 minutos. Sin proveedor configurado, la página explica que no se ha cobrado nada.</p>
    </Notice> : null}
  </div>
}
