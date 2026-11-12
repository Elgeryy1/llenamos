"use client"

import { useState } from "react"
import { PROMOTION_REJECTION_LABEL, type Bill } from "@llenamos/core"
import { SealPercentIcon } from "@phosphor-icons/react"
import { Notice } from "@/components/common/notice"
import { TextField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { permitido, llamarFidelizacion, type Acceso, type ApiFidelizacion } from "@/lib/fidelizacion/api"
import { useConsulta, useOperacion } from "@/lib/fidelizacion/hooks"
import { euros } from "@/lib/fidelizacion/presentacion"
import { Bloque, Datos, Resultado } from "./piezas"

export interface DescuentosCuentaProps extends Acceso {
  restaurantId: string
  locationId: string
  bill: Bill & { id: string }
  /** El padre vuelve a leer la cuenta real. El componente nunca calcula su nuevo total. */
  onBillChanged: (revision: number) => void | Promise<void>
  api?: ApiFidelizacion
}
export function DescuentosCuenta(props: DescuentosCuentaProps) {
  return <Descuentos key={JSON.stringify([props.restaurantId, props.locationId, props.bill.id, props.bill.customerId, props.role, props.modules])} {...props} />
}
function Descuentos(props: DescuentosCuentaProps) {
  const { restaurantId, locationId, bill, onBillChanged, api = llamarFidelizacion } = props
  const [codigo, escribirCodigo] = useState("")
  const [codigoConsultado, consultarCodigo] = useState<string | null>(null)
  const [motivo, escribirMotivo] = useState("")
  const [mensaje, mostrar] = useState<string | null>(null)
  const [revisionConfirmada, confirmarRevision] = useState(0)
  const op = useOperacion(api)
  const verPromociones = permitido(props, "promocionesAplicables")
  const verPuntos = permitido(props, "canjearPuntos")
  const promociones = useConsulta("promocionesAplicables", verPromociones ? { restaurantId, locationId, billId: bill.id, code: codigoConsultado } : null, api)
  const puntos = useConsulta("verCuentaFidelizacion", verPuntos && bill.customerId ? { restaurantId, customerId: bill.customerId } : null, api)
  const cerrada = bill.status !== "open"
  const pendiente = revisionConfirmada > bill.revision
  const ocupado = op.busy || pendiente || cerrada
  const promocionAplicada = bill.adjustments.some((a) => a.kind === "discount" && a.promotionId)
  const canjes = [...new Set(bill.adjustments.flatMap((a) => a.kind === "discount" && a.redemptionId ? [a.redemptionId] : []))]
  async function refrescar(revision: number) {
    confirmarRevision(revision)
    promociones.recargar()
    puntos.recargar()
    try { await onBillChanged(revision) } catch { mostrar("La operación está confirmada. Falta actualizar la cuenta antes de continuar.") }
  }
  if (!verPromociones && !verPuntos) return <Notice>Tu acceso no permite aplicar descuentos a esta cuenta.</Notice>
  return <Bloque titulo="Promociones y puntos" extra={<SealPercentIcon aria-hidden className="text-warning" size={22} />}>
    <p className="text-sm text-muted-foreground">Una promoción por cuenta. El servidor comprueba la hora, los cupos y la compatibilidad al aplicarla.</p>
    {cerrada ? <Notice>La cuenta no está abierta. No se pueden aplicar ni anular descuentos.</Notice> : null}
    {pendiente ? <Notice>Descuento confirmado. Esperando la cuenta actualizada para continuar.</Notice> : null}
    <Resultado error={op.mensaje} mensaje={mensaje} />
    {verPromociones ? <>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); consultarCodigo(codigo.trim().toUpperCase() || null); promociones.recargar() }}><TextField label="Código de promoción" maxLength={20} value={codigo} onChange={(e) => escribirCodigo(e.target.value)} fieldClassName="min-w-0 flex-1" /><Button type="submit" variant="outline" className="min-h-12" disabled={ocupado}>Consultar código</Button></form>
      <Datos live={promociones.live} recargar={promociones.recargar}>{(data) => <div>
        {data.best ? <p className="mb-2 text-xs text-success">Mayor descuento disponible: {data.best.name} · {euros(data.best.discountCents)}</p> : null}
        {data.evaluations.length === 0 ? <p className="text-sm text-muted-foreground">No hay promociones para esta cuenta.</p> : <ul className="divide-y">{data.evaluations.map((p) => <li key={p.promotionId} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="text-sm font-medium">{p.name}</p><p className="text-xs text-muted-foreground">{p.eligible ? `${euros(p.discountCents ?? 0)} de descuento` : p.reason ? PROMOTION_REJECTION_LABEL[p.reason] : "La promoción no se puede aplicar."}</p></div>{p.eligible ? <Button variant="outline" className="min-h-12" aria-label={`Aplicar ${p.name}`} disabled={ocupado || promocionAplicada} onClick={async () => {
          const r = await op.ejecutar("aplicarPromocion", { restaurantId, locationId, billId: bill.id, expectedBillRevision: bill.revision, promotionId: p.promotionId, code: codigoConsultado })
          if (!r) return
          if (r.status === "rejected") { mostrar(`${r.message} ${PROMOTION_REJECTION_LABEL[r.reason]}`); promociones.recargar(); return }
          mostrar(`Promoción confirmada. Descuento: ${euros(r.discountCents)}. Total de la cuenta: ${euros(r.totalCents)}.`)
          await refrescar(r.billRevision)
        }}>Aplicar</Button> : null}</li>)}</ul>}
      </div>}</Datos>
    </> : null}
    {verPuntos ? <div className="space-y-3 border-t pt-4"><h3 className="text-sm font-semibold">Canjear puntos</h3>{bill.customerId ? <Datos live={puntos.live} recargar={puntos.recargar}>{(data) => <>
      <p className="text-sm">{data.enrolled ? `${data.available} puntos disponibles` : "El cliente todavía no está dado de alta en fidelización."}</p>
      {data.rewards.length === 0 ? <p className="text-sm text-muted-foreground">Sin premios disponibles.</p> : <ul className="divide-y">{data.rewards.map((r) => <li key={r.rewardId} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-sm font-medium">{r.name}</p><p className="cifra text-xs text-muted-foreground">{r.pointsCost} puntos</p></div><Button className="min-h-12" variant="outline" aria-label={`Canjear ${r.name}`} disabled={ocupado || !data.enrolled || !r.affordable} onClick={async () => {
        const salida = await op.ejecutar("canjearPuntos", { restaurantId, locationId, customerId: bill.customerId!, billId: bill.id, expectedBillRevision: bill.revision, rewardId: r.rewardId })
        if (!salida) return
        if (salida.status === "insufficient") { mostrar(`No hay puntos suficientes. Saldo actual: ${salida.available}. El premio necesita ${salida.pointsCost}.`); puntos.recargar(); return }
        mostrar(`Canje confirmado. Descuento: ${euros(salida.discountCents)}. Quedan ${salida.available} puntos.`)
        await refrescar(salida.billRevision)
      }}>Canjear</Button></li>)}</ul>}
    </>}</Datos> : <Notice>Asocia un cliente a la cuenta para canjear sus puntos.</Notice>}</div> : null}
    {promocionAplicada || canjes.length ? <div className="space-y-3 border-t pt-4"><h3 className="text-sm font-semibold">Descuentos aplicados</h3><TextField label="Motivo para quitar o anular" value={motivo} maxLength={200} onChange={(e) => escribirMotivo(e.target.value)} /><div className="flex flex-wrap gap-2">
      {promocionAplicada && permitido(props, "quitarPromocion") ? <Button className="min-h-12" variant="outline" disabled={ocupado || !motivo.trim()} onClick={async () => { const r = await op.ejecutar("quitarPromocion", { restaurantId, locationId, billId: bill.id, expectedBillRevision: bill.revision, reason: motivo }); if (r) { mostrar("Promoción retirada por el servidor."); await refrescar(r.billRevision) } }}>Quitar promoción</Button> : null}
      {permitido(props, "anularCanje") ? canjes.map((id, i) => <Button key={id} className="min-h-12" variant="outline" disabled={ocupado || !motivo.trim()} onClick={async () => { const r = await op.ejecutar("anularCanje", { restaurantId, locationId, redemptionId: id, expectedBillRevision: bill.revision, reason: motivo }); if (r) { mostrar(`Canje anulado. Quedan ${r.available} puntos.`); await refrescar(r.billRevision) } }}>Anular canje {i + 1}</Button>) : null}
    </div></div> : null}
  </Bloque>
}
