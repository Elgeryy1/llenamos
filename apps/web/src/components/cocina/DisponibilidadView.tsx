"use client"

import { can, hasModule } from "@llenamos/core"
import Link from "next/link"
import { useState } from "react"
import { PageHeading } from "@/components/common/page-heading"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { usePanel } from "@/components/panel/PanelContext"
import { useNow } from "@/lib/use-now"
import { usePlatosEstacion } from "@/lib/cocina/datos"
import { errorCocina, llamarCocina } from "@/lib/cocina/callables"
import { Agotados } from "./Agotados"

/** Acceso a los recuentos para sala, sin entrar en el editor de carta ni en cocina. */
export function DisponibilidadView() {
  const { restaurant, location, role } = usePanel()
  if (!location || !can(role, "carta.agotar") || !hasModule(restaurant, "floor")) return <Notice>No tienes acceso a la disponibilidad de este local.</Notice>
  if (role === "kitchen" || role === "bar") return <><PageHeading title="Disponibilidad de tu estación" /><Button asChild className="h-12"><Link href={role === "kitchen" ? "/panel/cocina" : "/panel/barra"}>Abrir mi estación y sus agotados</Link></Button></>
  return <Recuentos key={`${restaurant.id}:${location.id}`} base={`restaurants/${restaurant.id}/locations/${location.id}`} />
}
function Recuentos({ base }: { base: string }) {
  const { restaurant, location } = usePanel(), items = usePlatosEstacion(base), now = useNow(30_000).getTime()
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("")
  const [uncertain, setUncertain] = useState(false)
  async function save(work: () => Promise<unknown>) {
    if (busy || uncertain) return
    setBusy(true); setMessage("")
    try { await work(); setMessage("Disponibilidad guardada.") }
    catch (error) {
      setMessage(errorCocina(error))
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
      if (!["functions/failed-precondition", "functions/invalid-argument", "functions/permission-denied", "functions/unauthenticated"].includes(code)) setUncertain(true)
    } finally { setBusy(false) }
  }
  const scope = { restaurantId: restaurant.id, locationId: location!.id }
  return <>
    <PageHeading title="Las raciones que quedan" description="Recuenta lo disponible hoy. Los pedidos descuentan solos y las anulaciones no reponen raciones." />
    {message ? <Notice title={uncertain ? "Comprueba el estado antes de repetir" : "Respuesta del servidor"}>{message}{uncertain ? <Button variant="outline" className="ml-3 h-12" onClick={() => window.location.reload()}>Volver a consultar</Button> : null}</Notice> : null}
    {items.status === "error" ? <Notice>{errorCocina(items.error)}</Notice> : items.status !== "ready" ? <p role="status">Cargando disponibilidad…</p> : <Agotados allItems items={items.data} stations={[]} station={{ id: "all", name: "todo el local", kind: "kitchen", sortOrder: 0, targetMinutes: 15, pickup: false, active: true }} defaultStationId={null} disabled={busy || uncertain} timezone={restaurant.timezone} now={now}
      onChange={(itemId, optionId, soldOut) => void save(() => llamarCocina("marcarAgotado", { ...scope, itemId, optionId, soldOut }))}
      onPortions={(itemId, variantId, remaining) => void save(() => llamarCocina("guardarRaciones", { ...scope, itemId, variantId, remaining }))} />}
  </>
}
