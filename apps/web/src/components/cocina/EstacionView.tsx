"use client"

import { ColaServicio } from "@/components/sin-conexion/ColaServicio"
import { IntencionGuardada } from "@/lib/sin-conexion/cliente"
import { hasModule, OrderLineSchema, MenuItemSchema, type StationKind, type TicketLine, type CallableInput } from "@llenamos/core"
import { useMemo, useRef, useState } from "react"
import { PageHeading } from "@/components/common/page-heading"
import { SegmentedControl } from "@/components/common/segmented-control"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Desplegable } from "@/components/common/desplegable"
import { EmptyState } from "@/components/common/empty-state"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { usePanel } from "@/components/panel/PanelContext"
import { useSala } from "@/lib/data/hooks"
import { Plano } from "@/components/sala/Plano"
import { useNow } from "@/lib/use-now"
import { errorCocina, llamarCocina } from "@/lib/cocina/callables"
import { leerDocumento, useDatosEstaciones, useLineasEstacion, usePlatosEstacion } from "@/lib/cocina/datos"
import { claveTicket, puedeVer, ticketsDeEstacion, type StationDoc } from "@/lib/cocina/modelo"
import { useAvisos } from "@/lib/cocina/use-avisos"
import { enVps } from "@/lib/sala/vivo"
import { Agotados } from "./Agotados"
import { MermaRapida } from "@/components/inventario/MermaRapida"
import { Ticket, type Preparacion } from "./Ticket"
import { cargarClienteDemo, cargarCocinaDemo, cargarFirestore } from "@/lib/firebase/cargar-demo"

export function EstacionView({ kind }: { kind: StationKind }) {
  const { role, restaurant, location, user } = usePanel()
  const title = kind === "kitchen" ? "Cocina" : "Barra"
  if (!puedeVer(role, kind)) return <><PageHeading title={title} /><EmptyState title="No tienes acceso a esta estación" description="Esta pantalla está reservada al equipo de la estación y a quien gestiona el restaurante." /></>
  if (!hasModule(restaurant, "floor") || !hasModule(restaurant, "kitchen")) return <><PageHeading title={title} /><EmptyState title="Cocina y sala deben estar activas" description="Este restaurante necesita los módulos de sala y cocina para preparar pedidos por estación." /></>
  if (!location) return <><PageHeading title={title} /><EmptyState title="Elige un local para ver sus estaciones" /></>
  // La clave desmonta listeners, acciones y avisos al cambiar de local o de cuenta.
  return <Estaciones key={`${restaurant.id}:${location.id}:${user.uid}:${role}:${kind}`} kind={kind} title={title} base={`restaurants/${restaurant.id}/locations/${location.id}`} />
}

function Estaciones({ kind, title, base }: { kind: StationKind; title: string; base: string }) {
  const { location } = usePanel()
  const { stations, settings } = useDatosEstaciones(base)
  const [generation, setGeneration] = useState(0)
  const [stationId, setStationId] = useState("")
  const own = stations.status === "ready" ? stations.data.filter((s) => s.kind === kind && s.active).sort((a, b) => a.sortOrder - b.sortOrder) : []
  const selected = own.find((s) => s.id === stationId) ?? own[0]
  const failure = stations.status === "error" ? stations.error : settings.status === "error" ? settings.error : null
  return <>
    <PageHeading title={title === "Cocina" ? "El pase de cocina" : "El pase de barra"} eyebrow={`${title} · ${location?.name}`} description="QR completo al aceptar. Los pases retenidos por el camarero esperan a sala con una tarea, incluso al pedir la cuenta." actions={<div className="flex flex-wrap items-end gap-3"><MermaRapida />{selected ? <div className="w-60"><label htmlFor="estacion" className="mb-1 block text-sm text-muted-foreground">Estación</label><Desplegable id="estacion" className="h-12! text-base" value={selected.id} onChange={(e) => setStationId(e.target.value)}>{own.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Desplegable></div> : null}</div>} />
    {failure ? <Notice title="No se puede abrir la estación" action={<Button variant="outline" className="h-12" onClick={() => window.location.reload()}>Volver a comprobar</Button>}>{errorCocina(failure)}</Notice> : stations.status !== "ready" || settings.status !== "ready" ? <p role="status" className="p-6 text-muted-foreground">Cargando estaciones y tiempos…</p> : !selected ? <EmptyState title="Aún no hay estaciones activas" description={`Pide a quien gestiona la carta que configure una estación de ${title.toLowerCase()} para este local.`} /> : <>
      <Pase key={`${selected.id}:${generation}`} onRefresh={() => setGeneration((g) => g + 1)} base={base} station={selected} stations={stations.data} pickupMinutes={settings.data.targets.pickupMinutes} defaultStationId={settings.data.defaultStationId} />
    </>}
  </>
}

function Pase({ base, station, stations, pickupMinutes, defaultStationId, onRefresh }: {
  onRefresh: () => void; base: string; station: StationDoc; stations: StationDoc[]; pickupMinutes: number; defaultStationId: string | null
}) {
  const { restaurant, location } = usePanel()
  const now = useNow(5_000).getTime()
  const [view, setView] = useState("tickets")
  const [filter, setFilter] = useState("all")
  const [alerts, setAlerts] = useState(false)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [revision, setRevision] = useState(0)
  const inFlight = useRef(false)
  const live = useLineasEstacion(base, station.id, station.kind, revision)
  const menu = usePlatosEstacion(view === "agotados" ? base : null)
  const lines = useMemo(() => live.status === "ready" ? live.data : [], [live])
  const tickets = useMemo(() => ticketsDeEstacion(lines, station, now, pickupMinutes), [lines, station, now, pickupMinutes])
  const announcement = useAvisos(lines, alerts && live.status === "ready" && !live.cached, now)
  const counts = { active: tickets.filter((t) => t.status === "active").length, ready: tickets.filter((t) => t.status === "ready").length, held: tickets.filter((t) => t.lines.some(l => l.status === "held")).length, late: tickets.filter((t) => t.delay?.level === "late").length }
  const context = { restaurantId: restaurant.id, locationId: location!.id }

  async function change<N extends "cambiarEstadoLineas" | "marcarAgotado" | "guardarRaciones">(name: N, input: CallableInput<N>) {
    if (inFlight.current || uncertain) return
    inFlight.current = true
    setBusy(true)
    setMessage("")
    try {
      await llamarCocina(name, input)
    } catch (error) {
      setMessage(errorCocina(error))
      if (error instanceof IntencionGuardada) return
      const code = error && typeof error === "object" && "code" in error ? error.code : ""
      // Los rechazos explícitos no han confirmado una escritura. El resto se consulta antes de repetir.
      if (!["functions/not-found", "functions/unimplemented", "functions/permission-denied", "functions/unauthenticated", "functions/invalid-argument", "functions/failed-precondition"].includes(String(code))) setUncertain(true)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  async function checkState() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      if (enVps) {
        // La API entrega una foto nueva al abrir la suscripción: se reabre desmontando el pase.
        onRefresh()
      } else {
        const [{ getDocsFromServer, collection, query }, { getFirebase }, { consultaLineas }] = await Promise.all([cargarFirestore(), cargarClienteDemo(), cargarCocinaDemo()])
        const db = getFirebase().db
        const [lineSnapshot, menuSnapshot] = await Promise.all([getDocsFromServer(consultaLineas(db, base, station.id, station.kind)), getDocsFromServer(query(collection(db, `${base}/menuItems`)))])
        lineSnapshot.docs.forEach((d) => leerDocumento(OrderLineSchema, `${base}/orderLines/${d.id}`, d.data()))
        menuSnapshot.docs.forEach((d) => leerDocumento(MenuItemSchema, `${base}/menuItems/${d.id}`, d.data()))
        setRevision((value) => value + 1)
      }
      setUncertain(false)
      setMessage("Estado consultado en el servidor. Revisa los platos y la disponibilidad antes de repetir la acción.")
    } catch (error) {
      setMessage(errorCocina(error))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const changeLine = (line: TicketLine, status: Preparacion) => {
    if (line.stationId !== station.id || line.stationKind !== station.kind) return
    void change("cambiarEstadoLineas", { ...context, lineIds: [line.id], status })
  }
  const disabled = busy || uncertain || live.status !== "ready"
  const visible = tickets.filter((t) => filter === "all" || (filter === "late" ? t.delay?.level === "late" : filter === "held" ? t.lines.some(l => l.status === "held") : t.status === filter))
  return <div className="space-y-3">
    <ColaServicio kitchen entities={[...lines.map(l => ({ kind: "line" as const, id: l.id, observed: l })), ...(menu.status === "ready" ? menu.data.filter(i => (i.stationId ?? defaultStationId) === station.id).map(i => ({ kind: "item" as const, id: i.id, observed: i })) : [])].slice(0, 100)} />
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2"><SegmentedControl label="Vista de la estación" options={[{ value: "tickets", label: "Tickets" }, { value: "agotados", label: "Agotados" }]} value={view} onValueChange={setView} className="[&_button]:h-12 [&_button]:min-w-24" /><Button variant="ghost" className="h-12" aria-pressed={alerts} onClick={() => setAlerts(!alerts)}>{alerts ? "Vibración activada" : "Activar vibración"}</Button></div>
      <p className="cifra text-lg text-muted-foreground">{live.status === "ready" && !live.cached ? "En directo" : "Sin conexión confirmada"} · {new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: restaurant.timezone }).format(now)}</p>
    </div>
    {alerts && typeof navigator !== "undefined" && !("vibrate" in navigator) ? <p className="text-sm text-muted-foreground">Este dispositivo no permite vibrar. Los retrasos siguen visibles en pantalla.</p> : null}
    <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
    {live.cached ? <Notice title="Sin conexión confirmada">Estos tickets son una copia del dispositivo. Los cambios que guardes quedarán pendientes de sincronizar.</Notice> : null}
    <SummaryStrip className="[&>div]:flex [&>div]:items-center [&>div]:gap-3 [&>div]:py-3 [&_dd]:mt-0 [&_dd]:text-2xl" label="Pulso de la estación" items={[{ label: "En marcha", value: counts.active }, { label: "En el pase", value: counts.ready, tone: "success" as const }, { label: "Con platos en espera", value: counts.held }, { label: "Con retraso", value: counts.late, tone: counts.late ? "warning" as const : undefined }].map((item) => ({ ...item, value: live.status === "ready" ? item.value : "…" }))} />
    {message ? <Notice title={uncertain ? "Hay que comprobar el estado" : "Respuesta del servidor"} action={uncertain ? <Button className="h-12" variant="outline" disabled={busy} onClick={() => void checkState()}>Comprobar estado</Button> : undefined}>{message}{uncertain ? <p>No repitas la acción hasta consultar el servidor.</p> : null}</Notice> : null}
    {busy ? <p role="status" className="text-sm text-muted-foreground">Esperando al servidor…</p> : null}
    {live.status === "error" ? <Notice title="No se pueden leer los tickets" action={<Button variant="outline" className="h-12" onClick={() => setRevision((r) => r + 1)}>Volver a comprobar</Button>}>{errorCocina(live.error)}</Notice> : live.status === "loading" ? <p role="status">Cargando tickets de {station.name}…</p> : view === "tickets" ? <>
      <div role="group" aria-label="Filtrar tickets" className="flex flex-wrap gap-2">{[["all", "Todos"], ["active", "En marcha"], ["ready", "En el pase"], ["held", "En espera"], ["late", "Con retraso"]].map(([value, label]) => <Button key={value} variant="outline" className={filter === value ? "h-12 bg-surface-raised shadow-soft" : "h-12"} aria-pressed={filter === value} onClick={() => setFilter(value!)}>{label}</Button>)}</div>
      {visible.length ? <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,310px),1fr))] items-start gap-4">{visible.map((ticket) => <Ticket key={claveTicket(ticket)} ticket={ticket} now={now} pickupMinutes={pickupMinutes} timezone={restaurant.timezone} disabled={disabled} onChange={changeLine} onBatch={(lineIds, status) => void change("cambiarEstadoLineas", { ...context, lineIds, status })} />)}</div> : <EmptyState title={tickets.length ? "No hay tickets en esta vista" : "Todo al día en esta estación"} description={tickets.length ? "Prueba con otro filtro para ver los demás pases." : "Los pedidos aparecerán aquí cuando la sala los envíe a esta estación. Los pedidos pendientes de aprobación aún no llegan a cocina."} />}
    </> : menu.status === "error" ? <Notice title="No se puede leer la carta">{errorCocina(menu.error)}</Notice> : menu.status === "loading" ? <p role="status">Cargando disponibilidad…</p> : <Agotados items={menu.data} stations={stations} station={station} defaultStationId={defaultStationId} disabled={disabled} timezone={restaurant.timezone} now={now} onPortions={(itemId, variantId, remaining) => void change("guardarRaciones", { ...context, itemId, variantId, remaining })} onChange={(itemId, optionId, soldOut) => void change("marcarAgotado", { ...context, itemId, optionId, soldOut })} />}
    <details className="superficie p-4"><summary className="flex min-h-12 cursor-pointer items-center text-base font-medium">Ver el plano de sala</summary><PlanoEstacion /></details>
  </div>
}

function PlanoEstacion() {
  const { restaurant, location } = usePanel()
  const sala = useSala(restaurant.id, location?.id ?? null)
  if (sala.status === "error") return <p className="py-3 text-sm text-muted-foreground">{errorCocina(sala.error)}</p>
  if (sala.status !== "ready") return <p className="py-3" role="status">Cargando plano…</p>
  const names = new Map(sala.data.tables.map((t) => [t.id, t.name]))
  return <div className="mt-3 space-y-4"><p className="text-sm text-muted-foreground">Ubicación de las mesas. El plano no indica el estado de los pedidos.</p>{sala.data.areas.map((area) => <Plano key={area.id} label={area.name} tables={sala.data.tables.filter((t) => t.areaId === area.id)} names={names} compact />)}</div>
}
