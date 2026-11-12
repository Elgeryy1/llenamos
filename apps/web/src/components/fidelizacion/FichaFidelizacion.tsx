"use client"

import { useState } from "react"
import { GiftIcon, WalletIcon } from "@phosphor-icons/react"
import { Notice } from "@/components/common/notice"
import { SummaryStrip } from "@/components/common/summary-strip"
import { TextField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { permitido, llamarFidelizacion, type Acceso, type ApiFidelizacion } from "@/lib/fidelizacion/api"
import { useConsulta, useOperacion } from "@/lib/fidelizacion/hooks"
import { MOVIMIENTOS } from "@/lib/fidelizacion/presentacion"
import { Bloque, Datos, Resultado } from "./piezas"

export interface FichaFidelizacionProps extends Acceso {
  restaurantId: string
  customerId: string
  customerName: string
  /** Versión leída de settings/loyalty. null impide dar un alta sin condiciones. */
  termsVersion: string | null
  termsText?: string
  locationId?: string
  reservationId?: string | null
  sessionId?: string | null
  timezone?: string
  api?: ApiFidelizacion
}
export function FichaFidelizacion(props: FichaFidelizacionProps) {
  // Reinicia formularios y peticiones al cambiar de cliente o permisos.
  return <Ficha key={JSON.stringify([props.restaurantId, props.customerId, props.role, props.modules, props.termsVersion])} {...props} />
}
function Ficha(props: FichaFidelizacionProps) {
  const { restaurantId, customerId, customerName, termsVersion, termsText, locationId, reservationId = null, sessionId = null, timezone = "Europe/Madrid", api = llamarFidelizacion } = props
  const verPuntos = permitido(props, "verCuentaFidelizacion")
  const verRepite = permitido(props, "verTarjetaRepite")
  const cuenta = useConsulta("verCuentaFidelizacion", verPuntos ? { restaurantId, customerId } : null, api)
  const tarjeta = useConsulta("verTarjetaRepite", verRepite ? { restaurantId, customerId } : null, api)
  const op = useOperacion(api)
  const [enlaceWallet, guardarEnlaceWallet] = useState<string | null>(null)
  const [tarjetaPendiente, pendienteTarjeta] = useState(false)
  const [acepta, aceptar] = useState(false)
  const [mensaje, mostrar] = useState<string | null>(null)
  const [ajuste, setAjuste] = useState("")
  const [motivo, setMotivo] = useState("")
  const fecha = (ms: number) => new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeZone: timezone }).format(ms)
  if (!verPuntos && !verRepite) return <Notice>Tu acceso no permite ver la fidelización de este cliente.</Notice>
  return <div className="space-y-5">
    <Resultado error={op.mensaje} mensaje={mensaje} />
    {verPuntos ? <Bloque titulo={`Fidelización de ${customerName}`} extra={<GiftIcon aria-hidden className="text-warning" size={22} />}>
      <Datos live={cuenta.live} recargar={cuenta.recargar}>{(data) => <>
        {data.enrolled ? <><SummaryStrip label="Puntos del cliente" items={[{ label: "Disponibles", value: data.available, tone: "success" }, { label: "Caducan en 30 días", value: data.expiringIn30Days, tone: data.expiringIn30Days ? "warning" : undefined }]} /><p className="text-sm text-muted-foreground">{data.earned} ganados · {data.redeemed} canjeados · {data.expired} caducados</p></> : <div className="space-y-4"><p className="text-sm">Todavía no está dado de alta en el programa.</p>{termsVersion ? <><p className="text-sm text-muted-foreground">Condiciones, versión {termsVersion}. {termsText ?? "Confirma con el cliente que ha leído y acepta las condiciones del programa del restaurante."}</p><label className="flex min-h-12 items-center gap-3 text-sm"><Checkbox checked={acepta} onCheckedChange={(v) => aceptar(v === true)} disabled={!permitido(props, "altaFidelizacion")} />El cliente acepta las condiciones del programa</label></> : <Notice>Falta la versión de las condiciones. No se puede registrar el alta.</Notice>}<p className="text-xs text-muted-foreground">El alta no da permiso para enviar campañas.</p>{permitido(props, "altaFidelizacion") ? <Button disabled={!acepta || !termsVersion || op.busy} onClick={async () => { const r = await op.ejecutar("altaFidelizacion", { restaurantId, customerId, acceptedTermsVersion: termsVersion! }); if (r) { mostrar(r.alreadyEnrolled ? "El cliente ya estaba dado de alta." : "Alta confirmada por el servidor."); cuenta.recargar() } }}>Dar de alta</Button> : null}</div>}
        {data.movements.length ? <div><h3 className="mb-2 text-sm font-medium">Últimos movimientos</h3><ul className="divide-y">{data.movements.map((m) => <li key={m.id} className="flex items-start justify-between gap-3 py-3"><div><p className="text-sm">{MOVIMIENTOS[m.kind] ?? "Movimiento de puntos"}</p><p className="text-xs text-muted-foreground">{fecha(m.at)}{m.reason ? ` · ${m.reason}` : ""}</p></div><div className="text-right"><p className={`cifra text-sm ${m.points > 0 ? "text-success" : "text-soft-foreground"}`}>{m.points > 0 ? "+" : ""}{m.points}</p><p className="text-xs text-muted-foreground">Saldo {m.balanceAfter}</p></div></li>)}</ul><p className="text-xs text-muted-foreground">Como máximo los 50 últimos movimientos.</p></div> : <p className="text-sm text-muted-foreground">Sin movimientos de puntos.</p>}
        {data.enrolled && permitido(props, "ajustarPuntos") ? <form className="space-y-3 border-t pt-4" onSubmit={async (e) => { e.preventDefault(); const r = await op.ejecutar("ajustarPuntos", { restaurantId, customerId, points: Number(ajuste), reason: motivo }); if (r) { mostrar(`Ajuste confirmado. Saldo disponible: ${r.available} puntos.`); cuenta.recargar() } }}><h3 className="text-sm font-medium">Ajustar puntos</h3><TextField label="Puntos que se añaden o se restan" type="number" step="1" required value={ajuste} onChange={(e) => setAjuste(e.target.value)} /><TextField label="Motivo del ajuste" required maxLength={200} value={motivo} onChange={(e) => setMotivo(e.target.value)} /><Button variant="outline" disabled={op.busy}>Registrar ajuste</Button></form> : null}
      </>}</Datos>
    </Bloque> : null}
    {verRepite ? <Bloque titulo="Tarjeta Repite" extra={<WalletIcon aria-hidden className="text-warning" size={22} />}><Datos live={tarjeta.live} recargar={tarjeta.recargar}>{(data) => <>
      {data.status === "ready" ? <><p className="cifra text-3xl">{data.card.stamps} <span className="text-base text-muted-foreground">de {data.card.stampsForReward} sellos</span></p><p className="text-sm">{data.card.rewardsAvailable} premios disponibles · {data.card.inWallet ? "Guardada en Wallet" : "Todavía sin guardar en Wallet"} · {data.card.status === "active" ? "Activa" : "Retirada"}</p><p className="text-xs text-muted-foreground">Consultada en Repite el {fecha(data.fetchedAt)}.</p></> : data.status === "no_card" ? <p className="text-sm">Este cliente todavía no tiene tarjeta.</p> : <Notice title={data.status === "not_configured" ? "Repite no está conectado" : "No se ha podido consultar Repite"}>{data.message}</Notice>}
      {tarjetaPendiente && data.status !== "ready" ? <Notice>La creación de la tarjeta sigue pendiente. Vuelve a consultar para comprobar si Repite la ha confirmado.</Notice> : null}
      {enlaceWallet ? <Button variant="outline" asChild><a href={enlaceWallet} target="_blank" rel="noopener noreferrer">Guardar tarjeta en Wallet</a></Button> : null}
      <Button variant="ghost" disabled={op.busy} onClick={tarjeta.recargar}>Consultar tarjeta de nuevo</Button>
      <div className="flex flex-wrap gap-2">{data.status === "no_card" && !tarjetaPendiente && permitido(props, "crearTarjetaRepite") ? <Button variant="outline" disabled={op.busy} onClick={async () => { const r = await op.ejecutar("crearTarjetaRepite", { restaurantId, customerId }); if (r) { if (r.status === "ready" && r.saveUrl) { try { const url = new URL(r.saveUrl); if (url.protocol === "https:") guardarEnlaceWallet(url.href) } catch { guardarEnlaceWallet(null) } } pendienteTarjeta(r.status === "queued"); mostrar(r.status === "ready" ? "Tarjeta creada y confirmada por Repite." : r.status === "queued" ? "Tarjeta pendiente. Repite todavía no la ha confirmado." : r.message); tarjeta.recargar() } }}>Crear tarjeta</Button> : null}
      {permitido(props, "darSelloRepite") && locationId && (reservationId || sessionId) ? <Button className="min-h-12" variant="outline" disabled={op.busy || data.status !== "ready" || data.card.status !== "active"} onClick={async () => { const r = await op.ejecutar("darSelloRepite", { restaurantId, locationId, customerId, reservationId, sessionId }); if (r) { mostrar(({ done: "Sello confirmado por Repite.", duplicate: "Esta visita ya tenía su sello. No se ha añadido otro.", queued: "Sello pendiente. Repite todavía no lo ha confirmado.", not_configured: "Repite no está conectado. No se ha confirmado el sello.", failed: "No se ha podido dar el sello. Revisa la operación antes de reintentar." })[r.status]); tarjeta.recargar() } }}>Dar sello de esta visita</Button> : null}
      {data.status === "ready" && permitido(props, "avisarTeEchamosDeMenos") ? <Button variant="outline" disabled={op.busy} onClick={async () => { const r = await op.ejecutar("avisarTeEchamosDeMenos", { restaurantId, customerIds: [customerId] }); if (r) mostrar(r.queued ? "Aviso pendiente de envío por Repite." : "No se ha encolado el aviso. Puede faltar tarjeta, permiso o haberse enviado hoy.") }}>Te echamos de menos</Button> : null}</div>
    </>}</Datos></Bloque> : null}
  </div>
}
