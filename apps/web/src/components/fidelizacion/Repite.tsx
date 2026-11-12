"use client"

import { useState } from "react"
import { defaultRepiteSettings, type RepiteSettings, type RepiteStampTrigger } from "@llenamos/core"
import { WalletIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { SummaryStrip } from "@/components/common/summary-strip"
import { useConsulta, useOperacion } from "@/lib/fidelizacion/hooks"
import { permitido, llamarFidelizacion, type Acceso, type ApiFidelizacion } from "@/lib/fidelizacion/api"
import { esquemas, useDocumento } from "@/lib/fidelizacion/datos"
import { Bloque, Datos, Resultado } from "./piezas"
import { useAccesoFidelizacion } from "./Marco"

export function Repite() {
  const acceso = useAccesoFidelizacion()
  const ajustes = useDocumento(acceso.restaurant.id, "settings/repite", esquemas.RepiteSettingsSchema, permitido(acceso, "guardarAjustesRepite"))
  return <Datos live={ajustes}>{(settings) => <RepiteVista key={`${acceso.restaurant.id}:${JSON.stringify(settings)}`} restaurantId={acceso.restaurant.id} acceso={acceso} settings={settings} />}</Datos>
}
export function RepiteVista({ restaurantId, acceso, settings, api = llamarFidelizacion }: { restaurantId: string; acceso: Acceso; settings: RepiteSettings | null; api?: ApiFidelizacion }) {
  const inicial = settings ?? defaultRepiteSettings()
  const [enabled, activar] = useState(inicial.enabled)
  const [stampOn, cuando] = useState(inicial.stampOn)
  const [autoCreateCard, crearSola] = useState(inicial.autoCreateCard)
  const [mes, cambiarMes] = useState(() => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit" }).format(new Date()))
  const [consultado, consultar] = useState<string | null>(null)
  const [mensaje, mostrar] = useState<string | null>(null)
  const op = useOperacion(api)
  const informe = useConsulta("informeRepite", consultado && permitido(acceso, "informeRepite") ? { restaurantId, month: consultado } : null, api)
  if (!permitido(acceso, "guardarAjustesRepite")) return <Notice>Tu rol no puede configurar Repite ni consultar su informe.</Notice>
  return <div className="space-y-5">
    <Notice title={inicial.merchantId ? "Restaurante vinculado a Repite" : "Repite no está conectado"}>{inicial.merchantId ? "La conexión se comprueba con Repite al consultar una tarjeta o su informe." : "LogiQD tiene que conectar el restaurante con Repite. Activar los sellos no crea una conexión."}</Notice>
    <div className="grid items-start gap-5 lg:grid-cols-2"><Bloque titulo="Sellos en la tarjeta" extra={<WalletIcon aria-hidden size={22} className="text-warning" />}><form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); mostrar(null); const r = await op.ejecutar("guardarAjustesRepite", { restaurantId, settings: { enabled, stampOn, autoCreateCard } }); if (r) mostrar(r.connected ? "Ajustes guardados. Repite está vinculado al restaurante." : "Ajustes guardados. Repite sigue sin estar conectado.") }}>
      <label className="flex min-h-11 items-center justify-between gap-3 text-sm">Dar sellos automáticamente<Switch checked={enabled} onCheckedChange={activar} /></label>
      <SelectField label="Cuándo dar el sello" value={stampOn} onChange={(e) => cuando(e.target.value as RepiteStampTrigger)}><option value="seated">Al sentar la reserva</option><option value="paid">Al cobrar la cuenta</option><option value="both">Al sentar o al cobrar</option></SelectField>
      <label className="flex min-h-11 items-center justify-between gap-3 text-sm">Crear tarjeta con el primer sello<Switch checked={autoCreateCard} onCheckedChange={crearSola} /></label>
      <p className="text-xs text-muted-foreground">Una visita recibe un solo sello, aunque se active al sentar y al cobrar. Si Repite no responde, la operación queda pendiente y la visita puede continuar.</p>
      <Resultado error={op.mensaje} mensaje={mensaje} /><Button disabled={op.busy}>Guardar ajustes</Button>
    </form></Bloque>
    <Bloque titulo="Informe del mes"><form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); consultar(mes); informe.recargar() }}><TextField label="Mes del informe" placeholder="2026-11" pattern="[0-9]{4}-(0[1-9]|1[0-2])" required maxLength={7} hint="Año y mes, por ejemplo 2026-11." value={mes} onChange={(e) => cambiarMes(e.target.value)} fieldClassName="min-w-0 flex-1" /><Button variant="outline">Consultar informe</Button></form><p className="text-xs text-muted-foreground">Repite es la fuente de estos datos. Un mes sin base de comparación no se representa como un cambio del 0 %.</p></Bloque></div>
    {consultado ? <Datos live={informe.live} recargar={informe.recargar}>{(data) => data.status === "ready" ? <Bloque titulo={`Repite en ${data.month}`}><SummaryStrip label="Informe de Repite" items={[{ label: "Visitas", value: data.visits }, { label: "Clientes nuevos", value: data.newCustomers }, { label: "Clientes que vuelven", value: data.returningCustomers }]} /><dl className="grid gap-4 text-sm sm:grid-cols-3"><div><dt className="text-muted-foreground">Premios canjeados</dt><dd className="cifra mt-1">{data.rewardsRedeemed}</dd></div><div><dt className="text-muted-foreground">Avisos enviados</dt><dd className="cifra mt-1">{data.noticesSent}</dd></div><div><dt className="text-muted-foreground">Volvieron tras el aviso</dt><dd className="cifra mt-1">{data.returnedAfterNotice}</dd></div></dl>{data.previous ? <div className="border-t pt-4"><h3 className="mb-3 text-sm font-medium">Mes anterior</h3><dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">{[["Visitas", data.previous.visits], ["Clientes nuevos", data.previous.newCustomers], ["Clientes que vuelven", data.previous.returningCustomers], ["Premios canjeados", data.previous.rewardsRedeemed], ["Avisos enviados", data.previous.noticesSent], ["Volvieron tras el aviso", data.previous.returnedAfterNotice]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="cifra">{value}</dd></div>)}</dl></div> : <Notice>No hay datos del mes anterior para comparar.</Notice>}</Bloque> : <Notice title={data.status === "not_configured" ? "Repite no está conectado" : "Informe no disponible"}>{data.message}</Notice>}</Datos> : null}
  </div>
}
