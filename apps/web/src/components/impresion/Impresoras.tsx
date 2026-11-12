"use client"
import { useState } from "react"
import { PrinterIcon, LinkIcon, GearIcon } from "@phosphor-icons/react"
import { type Printer, type CallableOutput } from "@llenamos/core"
import { usePanel } from "@/components/panel/PanelContext"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { RequireModule } from "@/components/panel/RequireModule"
import { PageHeading } from "@/components/common/page-heading"
import { Notice } from "@/components/common/notice"
import { TextField, SelectField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { useCloseOnHide } from "@/lib/open-state"
import { useImpresion, estadoImpresion } from "@/lib/impresion/datos"
import { useOperacionCaja } from "@/lib/caja/useOperacion"
import { errorCaja } from "@/lib/caja/api"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"

const initial: Printer = { name: "", bridgeId: "mostrador", paperMm: 80, columns: 48, stationIds: [], tickets: true, drawer: false, active: true }
export function Impresoras() {
  const { restaurant, location } = usePanel()
  return <RequirePermission permission="impresion.gestionar" what="las impresoras"><RequireModule module="pos">
    {location ? <Local key={`${restaurant.id}:${location.id}`} restaurantId={restaurant.id} locationId={location.id} /> : <Notice>Elige un local para configurar sus impresoras.</Notice>}
  </RequireModule></RequirePermission>
}
function Local({ restaurantId, locationId }: { restaurantId: string; locationId: string }) {
  const { user, location, restaurant } = usePanel()
  const { printers, stations, jobs } = useImpresion(restaurantId, locationId)
  const op = useOperacionCaja({ restaurantId, locationId }, user.uid)
  const [editing, setEditing] = useState(false), [printerId, setPrinterId] = useState<string | null>(null), [draft, setDraft] = useState<Printer>(initial)
  const [bridgeId, setBridgeId] = useState("mostrador"), [secret, setSecret] = useState<string | null>(null), [rotating, setRotating] = useState(false)
  useCloseOnHide(() => { setEditing(false); setSecret(null); setRotating(false) })
  const list = printers.status === "ready" ? printers.data : []
  const stationList = stations.status === "ready" ? stations.data.filter(s => s.active) : []
  const update = <K extends keyof Printer>(key: K, value: Printer[K]) => setDraft(v => ({ ...v, [key]: value }))
  async function pair() {
    setSecret(null); setRotating(false)
    const response = await op.run("vincularPuente", { bridgeId }, () => "Credencial renovada. Cópiala ahora en el ordenador del restaurante.")
    if (response) setSecret(response.token)
  }
  const recovered = op.result?.name === "vincularPuente" ? (op.result.data as CallableOutput<"vincularPuente">).token : null
  // El resultado puede recuperarse tras un corte; se muestra solo mientras la persona lo pida.
  const visibleToken = secret
  const lastPrintId = op.result?.name === "solicitarImpresion" ? (op.result.data as CallableOutput<"solicitarImpresion">).printJobId : null
  const lastPrint = jobs.status === "ready" ? jobs.data.find(j => j.id === lastPrintId) : null
  const operationMessage = lastPrint ? estadoImpresion[lastPrint.status] : op.message
  const error = [printers, stations, jobs].find(s => s.status === "error")
  return <div className="space-y-5">
    <PageHeading title="Cada papel en su sitio" eyebrow={location?.name} description="Comandas por estación y tickets en la caja, con confirmación del puente local." actions={<Button size="lg" className="min-h-12" disabled={op.blocked || printers.status !== "ready"} onClick={() => { setPrinterId(null); setDraft(initial); setEditing(true) }}><PrinterIcon aria-hidden />Añadir impresora</Button>} />
    <Notice tone="info" title="El puente tiene que estar encendido">Instala el puente en un ordenador del restaurante y configura allí la dirección de cada impresora. Aquí no se guardan direcciones de red. Un envío confirmado por TCP no comprueba que haya salido papel.</Notice>
    {op.error ? <Notice tone="error">{op.error}</Notice> : null}
    {operationMessage ? <p role="status" className={`text-sm ${lastPrint && ["failed", "uncertain", "not_configured"].includes(lastPrint.status) ? "text-warning" : "text-soft-foreground"}`}>{operationMessage}</p> : null}
    {op.pending ? <Notice tone="warning" title="Hay una operación sin respuesta">Recupera la misma operación antes de continuar.<Button variant="outline" className="mt-3 min-h-12" disabled={op.busy} onClick={() => void op.retry()}>Recuperar operación</Button></Notice> : null}
    {recovered && !visibleToken ? <Button variant="outline" onClick={() => setSecret(recovered)}>Mostrar credencial recuperada</Button> : null}
    {error?.status === "error" ? <Notice tone="error" title="No se pueden leer los datos">{errorCaja(error.error)}</Notice> : null}
    <section className="superficie overflow-hidden" aria-label="Impresoras del local">
      <div className="border-b px-5 py-4"><h2 className="text-lg font-semibold">Impresoras del local <span className="cifra text-muted-foreground">{list.length}</span></h2><p className="mt-1 text-sm text-muted-foreground">Una impresora para la caja y las que necesites para cocina y barra.</p></div>
      {printers.status === "loading" ? <p className="p-5" role="status">Cargando impresoras…</p> : !list.length ? <div className="p-8 text-center"><PrinterIcon size={32} className="mx-auto mb-3 text-muted-foreground" aria-hidden /><p className="font-medium">Aún no hay impresoras</p><p className="mt-2 text-sm text-muted-foreground">Vincula el puente y da de alta la primera impresora.</p></div> : <div className="divide-y">{list.map(p => <article key={p.id} className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 w-full sm:flex-1"><p className="flex flex-wrap items-center gap-2 font-medium"><PrinterIcon aria-hidden />{p.name}<span className={`text-xs ${p.active ? "text-success" : "text-muted-foreground"}`}>{p.active ? "Activa" : "Desactivada"}</span></p><p className="mt-2 text-sm text-muted-foreground">{p.paperMm} mm · {p.columns} columnas · Puente {p.bridgeId}</p><p className="mt-1 text-sm text-soft-foreground">{[p.tickets ? "Caja" : null, ...p.stationIds.map(id => stationList.find(s => s.id === id)?.name ?? id), p.drawer ? "Cajón habilitado" : null].filter(Boolean).join(" · ") || "Sin destinos"}</p><p className="cifra mt-2 break-all text-xs text-muted-foreground">Referencia local: {p.id}</p></div>
        <div className="flex shrink-0 flex-wrap gap-2"><Button variant="outline" className="min-h-12" disabled={op.blocked || !p.active} onClick={() => void op.run("solicitarImpresion", { printerId: p.id, kind: "test", sourceId: p.id, copy: false }, () => "Prueba en cola. Esperando la confirmación del puente.")}>Imprimir prueba</Button><Button variant="ghost" className="min-h-12" disabled={op.blocked} onClick={() => { setPrinterId(p.id); setDraft(p); setEditing(true) }}><GearIcon aria-hidden />Editar</Button></div>
      </article>)}</div>}
    </section>
    <section className="superficie p-5" aria-label="Vincular puente">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><LinkIcon aria-hidden />Vincular el ordenador del local</h2>
      <p className="mt-2 text-sm text-muted-foreground">Solo este restaurante y este local podrán usar la credencial. Renovarla desconecta la anterior. El identificador debe coincidir con el del archivo del puente.</p>
      <div className="mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-end"><TextField label="Identificador del puente" value={bridgeId} onChange={e => setBridgeId(e.target.value)} className="min-h-12" fieldClassName="w-full sm:max-w-80" /><Button variant="outline" className="min-h-12" disabled={op.blocked || !bridgeId.trim()} onClick={() => setRotating(true)}>Crear o renovar credencial</Button></div>
      <dl className="mt-4 space-y-1 text-xs text-muted-foreground"><div className="flex flex-wrap gap-1"><dt>Restaurante:</dt><dd className="cifra break-all">{restaurant.name} · {restaurantId}</dd></div><div className="flex gap-1"><dt>Local:</dt><dd className="cifra">{locationId}</dd></div></dl>
    </section>
    <section className="superficie overflow-hidden" aria-label="Cola de impresión"><div className="border-b px-5 py-4"><h2 className="text-lg font-semibold">Últimos trabajos</h2><p className="mt-1 text-sm text-muted-foreground">Un resultado incierto necesita revisar el papel antes de pedir una copia desde Caja.</p></div>
      {jobs.status === "loading" ? <p role="status" className="p-5">Cargando la cola…</p> : jobs.status === "ready" && !jobs.data.length ? <p className="p-5 text-sm text-muted-foreground">Aún no se han solicitado impresiones.</p> : jobs.status === "ready" ? <ul className="divide-y">{jobs.data.map(j => <li key={j.id} className="px-5 py-4"><div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{list.find(p => p.id === j.printerId)?.name ?? j.printerId}</span><span className={`text-sm ${j.status === "printed" ? "text-success" : ["failed", "uncertain"].includes(j.status) ? "text-warning" : "text-muted-foreground"}`}>{estadoImpresion[j.status]}</span></div><p className="mt-1 text-xs text-muted-foreground">{{ kitchen: "Comanda", invoice: "Factura", prebill: "Precuenta o prueba", drawer: "Cajón" }[j.kind]} · {j.attempts} {j.attempts === 1 ? "intento" : "intentos"}</p>{j.lastError ? <p className="mt-2 text-sm text-warning">{j.lastError}</p> : null}</li>)}</ul> : null}
    </section>
    <Dialog open={editing} onOpenChange={setEditing}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{printerId ? "Editar impresora" : "Añadir impresora"}</DialogTitle><DialogDescription>Perfil ESC/POS con CP858 y 203 puntos por pulgada. Comprueba la compatibilidad del modelo antes de usarlo en servicio.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={async e => { e.preventDefault(); const result = await op.run("guardarImpresora", { printerId, printer: draft }, () => "Impresora guardada. Ya puedes solicitar una prueba."); if (result) setEditing(false) }}><fieldset disabled={op.blocked} className="space-y-4">
        <TextField label="Nombre de la impresora" value={draft.name} required maxLength={60} onChange={e => update("name", e.target.value)} />
        <TextField label="Identificador del puente" value={draft.bridgeId} required onChange={e => update("bridgeId", e.target.value)} />
        <SelectField label="Ancho del papel" value={draft.paperMm} onChange={e => { const paperMm = Number(e.target.value) as 58 | 80; setDraft(v => ({ ...v, paperMm, columns: paperMm === 58 ? 32 : 48 })) }}><option value="80">80 mm · 48 columnas</option><option value="58">58 mm · 32 columnas</option></SelectField>
        <div><p className="mb-2 text-sm font-medium">Estaciones de comandas</p>{!stationList.length ? <p className="text-xs text-muted-foreground">No hay estaciones activas. Se configuran en Sala.</p> : stationList.map(s => <Check key={s.id} label={s.name} checked={draft.stationIds.includes(s.id)} onChange={checked => update("stationIds", checked ? [...draft.stationIds, s.id] : draft.stationIds.filter(id => id !== s.id))} />)}</div>
        <Check label="Tickets y facturas de la caja" checked={draft.tickets} onChange={v => update("tickets", v)} /><Check label="Cajón conectado a esta impresora" checked={draft.drawer} onChange={v => update("drawer", v)} /><Check label="Impresora activa" checked={draft.active} onChange={v => update("active", v)} />
        <DialogFooter><Button type="submit" className="min-h-12">Guardar impresora</Button></DialogFooter>
      </fieldset></form>
    </DialogContent></Dialog>
    <Dialog open={rotating} onOpenChange={setRotating}><DialogContent><DialogHeader><DialogTitle>Renovar la credencial del puente</DialogTitle><DialogDescription>La credencial anterior dejará de funcionar. Detén el puente, revisa sus trabajos pendientes y copia la nueva credencial en su archivo protegido.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setRotating(false)}>Cancelar</Button><Button disabled={op.blocked} onClick={() => void pair()}>Renovar credencial</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(visibleToken)} onOpenChange={open => { if (!open) setSecret(null) }}><DialogContent><DialogHeader><DialogTitle>Credencial del puente</DialogTitle><DialogDescription>Cópiala en el archivo protegido del ordenador del local. No la compartas. El servidor permite recuperar esta misma respuesta durante diez minutos.</DialogDescription></DialogHeader><code className="block break-all rounded-lg bg-surface-sunken p-4 text-sm select-all">{visibleToken}</code><Button variant="outline" onClick={() => setSecret(null)}>Ya la he guardado</Button></DialogContent></Dialog>
  </div>
}
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <Label className="flex min-h-11 cursor-pointer items-center gap-3"><Checkbox checked={checked} onCheckedChange={v => onChange(v === true)} />{label}</Label>
}
