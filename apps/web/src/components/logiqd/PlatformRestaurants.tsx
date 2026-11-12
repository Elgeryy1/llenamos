"use client"

import { useCallback, useEffect, useState } from "react"
import { MODULES, MODULE_LABEL, type AdministrativeRestaurant, type ModuleOverrides, type PublicPlanDefinition } from "@llenamos/core"
import { PageHeading } from "@/components/common/page-heading"
import { Notice } from "@/components/common/notice"
import { TextField, TextareaField, SelectField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useCloseOnHide } from "@/lib/open-state"
import { llamarCore } from "@/lib/data/callables"
import { usePlatformMutation } from "@/lib/integraciones/acciones"
import { TenantIntegrationFields, integrationChanges, type TenantIntegrations, type IntegrationProvider } from "./TenantIntegrationFields"

/** Nombre del plan; la versión de sus condiciones solo se muestra cuando ese plan tiene más de una. */
function planLabel(plans: PublicPlanDefinition[], id: string, version: number | string) {
  const same = plans.filter(plan => plan.id === id)
  const name = same[0]?.name ?? id
  const several = same.length > 1 || (same.length === 1 && String(same[0]!.version) !== String(version))
  return several ? `${name} (condiciones ${version})` : name
}

export function PlatformRestaurants() {
  const [rows, setRows] = useState<AdministrativeRestaurant[]>([])
  const [plans, setPlans] = useState<PublicPlanDefinition[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<AdministrativeRestaurant | null>(null)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useCloseOnHide(() => { setSelected(null); setCreating(false) })
  const load = useCallback(async (after: string | null = null) => {
    setLoading(true); setError(null)
    try {
      const [result, catalog] = await Promise.all([
        llamarCore("listarRestaurantesAdministracion", { cursor: after, limit: 25 }),
        llamarCore("listarPlanesDisponibles", {}),
      ])
      setRows(prev => after ? [...prev, ...result.restaurants] : result.restaurants)
      setCursor(result.nextCursor); setPlans(catalog.plans.filter(plan => plan.enabled))
    } catch (error) { setError(error instanceof Error ? error.message : "No se pudieron cargar los restaurantes.") }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { const timer = setTimeout(() => { void load() }, 0); return () => clearTimeout(timer) }, [load])
  const shown = rows.filter(row => `${row.name} ${row.slug} ${row.ownerEmail}`.toLocaleLowerCase("es").includes(search.toLocaleLowerCase("es")))
  return <div className="space-y-6">
    <PageHeading eyebrow="Equipo LogiQD · Administración" title="Restaurantes, planes y módulos" description="Da de alta restaurantes e invita a su propietario. La gestión interna y los datos de cada restaurante son privados." actions={<div className="flex flex-wrap gap-2"><Button variant="outline" disabled={loading} onClick={() => void load()}>Actualizar</Button><Button disabled={loading || !plans.length} onClick={() => setCreating(true)}>Dar de alta un restaurante</Button></div>} />
    <Notice tone="info">Desde aquí solo se administran el alta, el plan y los módulos. No puedes entrar en reservas, clientes, caja ni otras operaciones de los restaurantes.</Notice>
    <TextField label="Buscar entre los restaurantes cargados" type="search" value={search} onChange={event => setSearch(event.target.value)} />
    {error ? <Notice tone="error" title="No se ha podido cargar la administración">{error}</Notice> : null}
    {message ? <Notice tone="success">{message}</Notice> : null}
    <section className="superficie overflow-hidden"><h2 className="border-b p-5 text-lg font-semibold">Restaurantes</h2>
      {loading && !rows.length ? <p role="status" className="p-5">Cargando restaurantes…</p> : !shown.length ? <p className="p-5 text-sm text-muted-foreground">No hay restaurantes para esta búsqueda.</p> : <ul className="divide-y">{shown.map(row => <li key={row.restaurantId} className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-lg font-medium">{row.name}</h3><p className="text-sm text-muted-foreground">{row.slug} · Propietario: {row.ownerEmail}</p><p className="text-sm text-muted-foreground">Plan {planLabel(plans, row.planId, row.planVersion)} · {row.status}</p></div><Button variant="outline" onClick={() => setSelected(row)}>Configurar plan y módulos</Button></div>
        <div className="flex flex-wrap gap-2">{row.activeModules.map(module => <Badge key={module} variant="secondary">{MODULE_LABEL[module]}</Badge>)}</div>
      </li>)}</ul>}
    </section>
    {cursor ? <Button variant="outline" disabled={loading} onClick={() => void load(cursor)}>Cargar más restaurantes</Button> : null}
    <Sheet open={creating || selected !== null} onOpenChange={open => { if (!open) { setCreating(false); setSelected(null) } }}><SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
      {creating ? <CreateRestaurant plans={plans} onCreated={invitation => { setCreating(false); setMessage(invitation === "sent" ? "Restaurante creado. Hemos enviado la invitación a su propietario." : "Restaurante creado. La invitación está pendiente: falta configurar el correo de acceso de la plataforma."); void load() }} /> : selected ? <RestaurantDetail key={selected.restaurantId} row={selected} plans={plans} onChanged={() => { setSelected(null); void load() }} /> : null}
    </SheetContent></Sheet>
  </div>
}

function CreateRestaurant({ plans, onCreated }: { plans: PublicPlanDefinition[]; onCreated: (invitation: "sent" | "pending") => void }) {
  const [name, setName] = useState(""), [slug, setSlug] = useState(""), [locationName, setLocationName] = useState("")
  const [ownerName, setOwnerName] = useState(""), [ownerEmail, setOwnerEmail] = useState("")
  const [planKey, setPlanKey] = useState(plans[0] ? `${plans[0].id}:${plans[0].version}` : "")
  const action = usePlatformMutation()
  const [integrations, setIntegrations] = useState<TenantIntegrations>({})
  return <><SheetHeader><SheetTitle>Dar de alta un restaurante</SheetTitle><SheetDescription>Las APIs son opcionales. Con el correo de acceso disponible enviaremos al propietario un enlace para preparar su contraseña. LogiQD no accede a ella ni al panel interno.</SheetDescription></SheetHeader>
    <form className="space-y-5 px-4 pb-6" onSubmit={event => { event.preventDefault(); const plan = plans.find(plan => `${plan.id}:${plan.version}` === planKey); if (!plan) return; void action.mutate("altaRestauranteLogiqd", { name, slug, locationName, ownerName, ownerEmail, planId: plan.id, planVersion: plan.version, ...integrationChanges(integrations, []) }).then(result => { if (result) { setIntegrations({}); onCreated(result.invitationStatus) } }) }}>
      <TextField label="Restaurante" value={name} onChange={event => setName(event.target.value)} minLength={2} maxLength={80} required disabled={action.pending} />
      <TextField label="Identificador público" hint="Letras minúsculas, números y guiones. Se usa en el enlace de reservas." value={slug} onChange={event => setSlug(event.target.value)} required disabled={action.pending} />
      <TextField label="Nombre del local" value={locationName} onChange={event => setLocationName(event.target.value)} minLength={2} maxLength={80} required disabled={action.pending} />
      <TextField label="Nombre del propietario" value={ownerName} onChange={event => setOwnerName(event.target.value)} maxLength={80} required disabled={action.pending} />
      <TextField label="Correo del propietario" type="email" value={ownerEmail} onChange={event => setOwnerEmail(event.target.value)} required disabled={action.pending} />
      <SelectField label="Plan contratado" value={planKey} onChange={event => setPlanKey(event.target.value)} disabled={action.pending}>{plans.map(plan => <option key={`${plan.id}:${plan.version}`} value={`${plan.id}:${plan.version}`}>{planLabel(plans, plan.id, plan.version)}</option>)}</SelectField>
      <TenantIntegrationFields values={integrations} onChange={setIntegrations} removed={[]} onRemove={() => {}} disabled={action.pending} />
      {action.error ? <Notice tone="error" title="No se ha completado el alta">{action.error}</Notice> : null}
      <Button type="submit" className="w-full" disabled={action.pending || !planKey}>{action.pending ? "Creando restaurante…" : "Crear restaurante"}</Button>
    </form></>
}

function RestaurantDetail({ row, plans, onChanged }: { row: AdministrativeRestaurant; plans: PublicPlanDefinition[]; onChanged: () => void }) {
  const [reason, setReason] = useState("")
  const [overrides, setOverrides] = useState<ModuleOverrides>(row.moduleOverrides)
  const [planKey, setPlanKey] = useState(`${row.planId}:${row.planVersion}`)
  const action = usePlatformMutation()
  const [integrations, setIntegrations] = useState<TenantIntegrations>({})
  const [removed, setRemoved] = useState<IntegrationProvider[]>([])
  return <><SheetHeader><SheetTitle>{row.name}</SheetTitle><SheetDescription>Solo configuración administrativa. Propietario: {row.ownerEmail}.</SheetDescription></SheetHeader>
    <form className="space-y-5 px-4 pb-6" onSubmit={event => { event.preventDefault(); const plan = plans.find(plan => `${plan.id}:${plan.version}` === planKey); if (!plan) return; void action.mutate("configurarRestauranteLogiqd", { restaurantId: row.restaurantId, expectedRevision: row.revision, planId: plan.id, planVersion: plan.version, moduleOverrides: overrides, reason, ...integrationChanges(integrations, removed) }).then(result => { if (result) { setIntegrations({}); onChanged() } }) }}>
      <SelectField label="Plan contratado" value={planKey} onChange={event => setPlanKey(event.target.value)} disabled={action.pending}>{!plans.some(plan => `${plan.id}:${plan.version}` === planKey) ? <option value={planKey}>{planLabel(plans, row.planId, row.planVersion)}</option> : null}{plans.map(plan => <option key={`${plan.id}:${plan.version}`} value={`${plan.id}:${plan.version}`}>{planLabel(plans, plan.id, plan.version)}</option>)}</SelectField>
      {MODULES.map(module => <SelectField key={module} label={MODULE_LABEL[module]} disabled={action.pending} value={overrides[module] === undefined ? "plan" : overrides[module] ? "on" : "off"} onChange={event => setOverrides(previous => { const next = { ...previous }; if (event.target.value === "plan") delete next[module]; else next[module] = event.target.value === "on"; return next })}><option value="plan">Según el plan</option><option value="on">Encendido</option><option value="off">Apagado</option></SelectField>)}
      <TenantIntegrationFields values={integrations} onChange={setIntegrations} statuses={row.integrationStatus ?? {}} removed={removed} onRemove={setRemoved} disabled={action.pending} />
      <TextareaField label="Motivo del cambio" value={reason} onChange={event => setReason(event.target.value)} maxLength={200} required disabled={action.pending} />
      {action.error ? <Notice tone="error" title="No se ha completado la configuración">{action.error}</Notice> : null}
      <Button type="submit" disabled={action.pending || !reason.trim()}>{action.pending ? "Guardando…" : "Guardar plan y módulos"}</Button>
    </form></>
}
