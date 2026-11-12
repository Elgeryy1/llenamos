"use client"

import { useCallback, useEffect, useState } from "react"
import { API_SCOPES, PLATFORM_EVENTS, type ApiScope, type CallableOutput, type PlatformEvent } from "@llenamos/core"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { usePanel } from "@/components/panel/PanelContext"
import { PageHeading } from "@/components/common/page-heading"
import { Notice } from "@/components/common/notice"
import { TextField, SelectField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { llamarCore } from "@/lib/data/callables"
import { usePlatformMutation } from "@/lib/integraciones/acciones"
import { useCloseOnHide } from "@/lib/open-state"
import { ApiDocs } from "./ApiDocs"

type Listing = CallableOutput<"listarIntegraciones">
const labelStatus: Record<string, string> = { queued: "En cola", leased: "En curso", retry: "Esperando reintento", delivered: "Entregada", exhausted: "Requiere revisión", cancelled: "Cancelada", active: "Activo", suspended: "Suspendido", revoked: "Revocado" }
export function IntegracionesView() {
  const { restaurant, location, locations } = usePanel()
  return <RequirePermission permission="integraciones.gestionar" what="las integraciones"><Content key={restaurant.id} rid={restaurant.id} lid={location?.id ?? null} locations={locations} /></RequirePermission>
}
function Content({ rid, lid, locations }: { rid: string; lid: string | null; locations: { id: string; name: string }[] }) {
  const [measuredAt, setMeasuredAt] = useState(0)
  const [data, setData] = useState<Listing | null>(null), [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false), [secret, setSecret] = useState<string | null>(null)
  const [name, setName] = useState(""), [url, setUrl] = useState(""), [chosen, setChosen] = useState(lid ?? locations[0]?.id ?? "")
  const [scopes, setScopes] = useState<ApiScope[]>(["menu.read"]), [event, setEvent] = useState<PlatformEvent["type"]>("order.placed")
  const [expiresAt] = useState(() => Date.now() + 30 * 86_400_000), [reason, setReason] = useState("")
  const action = usePlatformMutation()
  useCloseOnHide(() => setSecret(null))
  const load = useCallback(async (cursor: string | null = null) => {
    setLoading(true); setError(null)
    try {
      const result = await llamarCore("listarIntegraciones", { restaurantId: rid, cursor, limit: 20 })
      setMeasuredAt(Date.now())
      setData(previous => cursor && previous ? { keys: [...previous.keys, ...result.keys], endpoints: [...previous.endpoints, ...result.endpoints], deliveries: [...previous.deliveries, ...result.deliveries], nextCursor: result.nextCursor, workerLastRunAt: result.workerLastRunAt } : result)
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudieron cargar las integraciones.") }
    finally { setLoading(false) }
  }, [rid])
  useEffect(() => { const timer = setTimeout(() => { void load() }, 0); return () => clearTimeout(timer) }, [load])
  async function createKey() { const r = await action.mutate("crearClaveApi", { restaurantId: rid, name, scopes, locationIds: [chosen], expiresAt }); if (r) { setSecret(r.token); await load() } }
  async function createWebhook() { const r = await action.mutate("guardarWebhook", { restaurantId: rid, endpointId: null, url, events: [event], locationIds: [chosen], status: "active" }); if (r) { setSecret(r.secret); await load() } }
  return <div className="space-y-6">
    <PageHeading eyebrow="Conexiones del restaurante" title="API y webhooks" description="Conecta tu aplicación con claves por local y recibe eventos firmados. Los límites dependen del plan configurado." actions={<Button variant="outline" disabled={loading} onClick={() => void load()}>{loading ? "Actualizando…" : "Actualizar"}</Button>} />
    {error || action.error ? <Notice tone="error" title="No se ha completado la operación">{error ?? action.error}</Notice> : null}
    {secret ? <Notice tone="warning" title="Guarda este secreto ahora"><p>No se muestra en los listados. Guárdalo en un lugar seguro antes de cerrar.</p><code className="my-3 block break-all select-all text-sm">{secret}</code><Button variant="outline" onClick={() => { void navigator.clipboard.writeText(secret).catch(() => setError("Selecciona el secreto y cópialo manualmente.")) }}>Copiar secreto</Button> <Button variant="ghost" onClick={() => setSecret(null)}>Ocultar</Button></Notice> : null}
    <section className="superficie p-5"><h2 className="mb-3 text-lg font-semibold">Local autorizado</h2><SelectField label="Local para las nuevas integraciones" value={chosen} onChange={e => setChosen(e.target.value)}>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</SelectField><p className="mt-2 text-sm text-muted-foreground">Cada integración nueva queda acotada a este local. Revisa el alcance antes de crearla.</p></section>
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="superficie space-y-4 p-5"><h2 className="text-lg font-semibold">Crear clave de API</h2><TextField label="Nombre de la aplicación" value={name} onChange={e => setName(e.target.value)} maxLength={80} /><fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">Alcances</legend>{API_SCOPES.map(s => <label key={s} className="flex min-h-11 items-center gap-3 text-sm"><Checkbox checked={scopes.includes(s)} onCheckedChange={checked => setScopes(prev => checked ? [...prev, s] : prev.filter(x => x !== s))} /><span>{s === "menu.read" ? "Consultar carta" : "Consultar pedidos"} <code className="text-xs text-muted-foreground">{s}</code></span></label>)}</fieldset><p className="text-sm text-muted-foreground">Caduca en 30 días. No permite escribir pedidos ni leer contactos.</p><Button disabled={action.pending || !name.trim() || !chosen || !scopes.length} onClick={() => void createKey()}>Crear clave</Button></section>
      <section className="superficie space-y-4 p-5"><h2 className="text-lg font-semibold">Crear webhook</h2><TextField label="URL del receptor HTTPS" type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://tu-aplicacion.com/eventos" /><SelectField label="Evento" value={event} onChange={e => setEvent(e.target.value as PlatformEvent["type"])}>{PLATFORM_EVENTS.map(e => <option key={e} value={e}>{e}</option>)}</SelectField><p className="text-sm text-muted-foreground">El servidor comprueba el destino en cada conexión. No admite redes privadas ni redirecciones.</p><Button variant="outline" disabled={action.pending || !url || !chosen} onClick={() => void createWebhook()}>Crear webhook</Button></section>
    </div>
    <section className="superficie overflow-hidden"><h2 className="border-b p-5 text-lg font-semibold">Claves de API</h2>{!data ? <p className="p-5" role="status">{loading ? "Cargando claves…" : "No se han cargado las claves."}</p> : !data.keys.length ? <p className="p-5 text-sm text-muted-foreground">Aún no hay claves de API.</p> : <ul className="divide-y">{data.keys.map(k => <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 p-5"><div className="min-w-0"><h3 className="font-medium">{k.name}</h3><p className="break-all text-sm text-muted-foreground"><code>{k.prefix}…</code> · {k.scopes.join(", ")}</p><p className="text-xs text-muted-foreground">{k.revokedAt !== null ? "Revocada" : k.expiresAt <= measuredAt ? "Caducada" : `Caduca el ${new Date(k.expiresAt).toLocaleDateString("es")}`} · {k.locationIds.map(id => locations.find(l => l.id === id)?.name ?? id).join(", ")}</p></div><Button variant="outline" disabled={action.pending || k.revokedAt !== null} onClick={async () => { if (await action.mutate("revocarClaveApi", { restaurantId: rid, keyId: k.id })) await load() }}>Revocar</Button></li>)}</ul>}</section>
    <section className="superficie overflow-hidden"><h2 className="border-b p-5 text-lg font-semibold">Webhooks</h2>{!data?.endpoints.length ? <p className="p-5 text-sm text-muted-foreground">Aún no hay webhooks.</p> : <ul className="divide-y">{data.endpoints.map(e => <li key={e.id} className="space-y-3 p-5"><div className="flex flex-wrap justify-between gap-2"><p className="min-w-0 break-all font-medium">{e.url}</p><span className="text-sm">{labelStatus[e.status]} · secreto v{e.secretVersion}</span></div><p className="break-words text-xs text-muted-foreground">{e.events.join(", ")} · {e.locationIds.map(id => locations.find(l => l.id === id)?.name ?? id).join(", ")}</p><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={action.pending || e.status === "revoked"} onClick={async () => { const r = await action.mutate("rotarSecretoWebhook", { restaurantId: rid, endpointId: e.id }); if (r) { setSecret(r.secret); await load() } }}>Rotar secreto</Button><Button variant="outline" disabled={action.pending || e.status === "revoked"} onClick={async () => { if (await action.mutate("guardarWebhook", { restaurantId: rid, endpointId: e.id, url: e.url, events: e.events, locationIds: e.locationIds, status: "revoked" })) await load() }}>Revocar webhook</Button></div></li>)}</ul>}</section>
    <section className="superficie space-y-4 p-5"><h2 className="text-lg font-semibold">Entregas</h2><p className="text-sm text-muted-foreground">El trabajador se ejecuta explícitamente en local. En cola significa pendiente de envío. No hay entrega confirmada hasta recibir una respuesta válida.</p><p className="text-sm text-warning">{data?.workerLastRunAt ? `Última ejecución: ${new Date(data.workerLastRunAt).toLocaleString("es")}. ${measuredAt - data.workerLastRunAt > 300_000 ? "Sin ejecución reciente." : "La fecha de ejecución no acredita que el trabajador siga activo."}` : "Trabajador sin ejecutar. No hay una medición de ejecución."}</p><TextField label="Motivo para repetir una entrega" value={reason} onChange={e => setReason(e.target.value)} maxLength={200} />{!data?.deliveries.length ? <p className="text-sm text-muted-foreground">Aún no hay entregas.</p> : <ul className="divide-y">{data.deliveries.map(d => <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div className="min-w-0"><p className="break-all text-sm">Evento {d.eventId}</p><p className="text-sm text-muted-foreground">{labelStatus[d.status]} · {d.attempts} intentos{d.lastStatus ? ` · HTTP ${d.lastStatus}` : ""}</p>{d.lastAttemptAt ? <p className="text-xs text-muted-foreground">Último intento: {new Date(d.lastAttemptAt).toLocaleString("es")}</p> : null}{d.status === "retry" ? <p className="text-xs text-muted-foreground">Próximo intento a partir de {new Date(d.nextAttemptAt).toLocaleString("es")}</p> : null}{d.lastError ? <p className="text-xs text-warning">{d.lastError}</p> : null}</div><Button variant="outline" disabled={action.pending || !reason.trim() || !["delivered", "exhausted"].includes(d.status)} onClick={async () => { if (await action.mutate("repetirEntregaWebhook", { restaurantId: rid, deliveryId: d.id, reason })) await load() }}>Repetir</Button></li>)}</ul>}{data?.nextCursor ? <Button variant="outline" disabled={loading} onClick={() => void load(data.nextCursor)}>Cargar más</Button> : null}</section>
    <ApiDocs restaurantId={rid} locationId={lid} />
  </div>
}
