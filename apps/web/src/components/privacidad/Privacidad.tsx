'use client'
import { useEffect,useRef,useState } from 'react'
import type { Consent,PrivacyJob } from '@llenamos/core'
import { ShieldCheckIcon,DownloadSimpleIcon,ArrowClockwiseIcon } from '@phosphor-icons/react'
import { usePanel } from '@/components/panel/PanelContext'
import { RequirePermission } from '@/components/panel/RequirePermission'
import { PageHeading } from '@/components/common/page-heading'
import { Notice } from '@/components/common/notice'
import { SettingsSection } from '@/components/common/settings-section'
import { TextField,TextareaField,SelectField } from '@/components/common/form-fields'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/common/empty-state'
import { LoadingBlock } from '@/components/common/loading'
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter } from '@/components/ui/dialog'
import { useCloseOnHide } from '@/lib/open-state'
import * as api from '@/lib/privacidad/api'
import { useNow } from '@/lib/reservas/hooks'
import { useCustomers } from '@/lib/data/reservas'
const statusText:Record<PrivacyJob['status'],string> = { requested:'Pendiente de verificar',verified:'Identidad verificada',running:'En curso',completed:'Terminada',blocked:'Requiere revisión',failed:'No se ha completado' }
export function Privacidad() { const { restaurant } = usePanel();return <RequirePermission permission="privacidad.gestionar" what="la privacidad"><PrivacyView key={restaurant.id} /></RequirePermission> }
function PrivacyView() {
  const { restaurant } = usePanel(), rid = restaurant.id
  const customers = useCustomers(rid)
  const [jobs,setJobs] = useState<api.PrivacyList['jobs']>([]),[cursor,setCursor] = useState<string|null>(null)
  const now = useNow()
  const [loading,setLoading] = useState(true),[busy,setBusy] = useState(false),[error,setError] = useState(''),[notice,setNotice] = useState('')
  const [customerId,setCustomerId] = useState(''),[kind,setKind] = useState<'export'|'erase'>('export'),[reason,setReason] = useState('')
  const [evidenceId,setEvidenceId] = useState(''),[purpose,setPurpose] = useState<Consent['purpose']>('marketing_email'),[consentStatus,setConsentStatus] = useState<Consent['status']>('withdrawn'),[policyVersion,setPolicyVersion] = useState('')
  const [confirm,setConfirm] = useState(false)
  const intent = useRef<{ key:string;id:string }|null>(null)
  useCloseOnHide(() => setConfirm(false))
  useEffect(() => {
    let active = true
    api.listJobs(rid).then(result => { if (active) { setJobs(result.jobs);setCursor(result.nextCursor) } }).catch(() => { if (active) setError('No se han podido consultar las solicitudes. Revisa la conexión y vuelve a cargar.') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  },[rid])
  async function refresh(next = false) { const result = await api.listJobs(rid,next ? cursor : null); setJobs(old => next ? [...old,...result.jobs] : result.jobs);setCursor(result.nextCursor) }
  async function run(work:()=>Promise<void>) {
    setBusy(true);setError('');setNotice('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message.replace(/^Firebase:\s*/,'') : 'No se ha podido completar la operación. Reintenta la misma solicitud.') }
    finally { setBusy(false) }
  }
  function requestId(key:string) {
    if (intent.current?.key !== key) intent.current = { key,id:crypto.randomUUID() }
    return intent.current.id
  }
  async function submit() {
    setConfirm(false)
    await run(async () => {
      const data = { restaurantId:rid,customerId:customerId.trim(),kind,reason:reason.trim() }, key = JSON.stringify(data)
      await api.requestPrivacy({ ...data,requestId:requestId(key) }); intent.current = null
      setNotice('Solicitud registrada. Verifica la identidad antes de que el trabajador la procese.');await refresh()
    })
  }
  return <div className="space-y-6">
    <PageHeading eyebrow={`Protección de datos · ${restaurant.name}`} title="Cada dato, con un propósito" description="Gestiona los permisos y atiende las solicitudes de las personas con una comprobación previa de identidad." actions={<Button variant="outline" disabled={busy} onClick={() => void run(() => refresh())}><ArrowClockwiseIcon aria-hidden />Actualizar</Button>} />
    <Notice tone="warning" title="Herramientas de privacidad, con límites">Los originales fiscales y las retenciones justificadas se conservan con acceso restringido. Los plazos y las bases jurídicas requieren una política validada antes de vender este servicio.</Notice>
    {error ? <Notice tone="error">{error}</Notice> : null}
    {notice ? <Notice tone="success">{notice}</Notice> : null}
    <div className="grid gap-6 lg:grid-cols-2">
      <SettingsSection id="solicitud" title="Atender una solicitud" description="La petición queda registrada antes de exportar o suprimir datos.">
        <SelectField label="Cliente" hint="Comprueba el nombre y el teléfono antes de registrar una solicitud." value={customerId} onChange={e => setCustomerId(e.target.value)} disabled={customers.status !== 'ready'}><option value="">Elige una persona de la agenda</option>{customers.status === 'ready' ? customers.data.map(customer => <option key={customer.id} value={customer.id}>{customer.name} · {customer.phone}</option>) : null}</SelectField>
        {customers.status === 'error' ? <Notice tone="error">No se ha podido consultar la agenda. Necesitas acceso a los clientes del restaurante para elegir una ficha.</Notice> : null}
        <SelectField label="Qué solicita" value={kind} onChange={e => setKind(e.target.value as 'export'|'erase')}><option value="export">Exportar sus datos</option><option value="erase">Borrar o anonimizar sus datos</option></SelectField>
        <TextareaField label="Motivo de la solicitud" hint="Describe la gestión sin repetir teléfonos, correos ni alergias." maxLength={200} value={reason} onChange={e => setReason(e.target.value)} />
        <Button className="self-start" disabled={busy || !customerId.trim() || !reason.trim()} onClick={() => kind === 'erase' ? setConfirm(true) : void submit()}>Registrar solicitud</Button>
      </SettingsSection>
      <SettingsSection id="consentimiento" title="Permisos separados, siempre con prueba" description="Importar un contacto o enviar una confirmación de reserva no concede permiso para campañas.">
        <TextField label="Referencia de la evidencia" hint="La comprobación debe haberse registrado por el procedimiento interno. Una referencia inventada se rechaza." value={evidenceId} onChange={e => setEvidenceId(e.target.value)} />
        <SelectField label="Propósito del permiso" value={purpose} onChange={e => setPurpose(e.target.value as Consent['purpose'])}><option value="marketing_email">Campañas por correo</option><option value="marketing_whatsapp">Campañas por WhatsApp</option><option value="digital_receipt">Recibo digital</option></SelectField>
        <div className="grid gap-4 sm:grid-cols-2"><SelectField label="Decisión de la persona" value={consentStatus} onChange={e => setConsentStatus(e.target.value as Consent['status'])}><option value="withdrawn">Retira el permiso</option><option value="granted">Da su permiso</option></SelectField><TextField label="Versión de la política" value={policyVersion} onChange={e => setPolicyVersion(e.target.value)} maxLength={80} /></div>
        <Button variant="outline" className="self-start" disabled={busy || !customerId.trim() || !evidenceId.trim() || !policyVersion.trim()} onClick={() => void run(async () => {
          const data = { restaurantId:rid,customerId:customerId.trim(),purpose,status:consentStatus,policyVersion:policyVersion.trim(),evidenceId:evidenceId.trim() }
          const result = await api.registerConsent({ ...data,requestId:requestId(JSON.stringify(data)) });intent.current = null
          setNotice(`Decisión registrada. Referencia ${result.consentId.slice(0,12)}. El historial se incluye en la exportación personal.`)
        })}>Registrar decisión</Button>
      </SettingsSection>
    </div>
    <section className="superficie overflow-hidden" aria-labelledby="trabajos"><div className="flex items-center gap-3 border-b px-5 py-4"><ShieldCheckIcon size={22} className="text-primary" aria-hidden /><h2 id="trabajos" className="font-semibold">Solicitudes y resultados</h2><span className="ml-auto cifra text-sm text-muted-foreground">{jobs.length} cargadas</span></div>
      {loading ? <div className="p-5"><LoadingBlock label="Cargando solicitudes" /></div> : !jobs.length ? <EmptyState title="Aún no hay solicitudes" description="Registra la primera solicitud y verifica la identidad antes de ejecutarla." /> : <div className="divide-y">{jobs.map(job => <div key={job.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
        <div className="min-w-0 flex-1 basis-52"><p className="font-medium">{job.kind === 'export' ? 'Exportación personal' : 'Borrado y anonimización'}</p><p className="mt-1 break-all text-xs text-muted-foreground">{customers.status === 'ready' ? customers.data.find(c => c.id === job.customerId)?.name ?? 'Ficha suprimida o fuera de la agenda cargada' : 'Ficha de cliente'}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(job.requestedAt).toLocaleString('es-ES')} · {job.processed} copias revisadas</p></div>
        <div className="flex-1 basis-48"><p className={job.status === 'completed' ? 'text-success' : job.status === 'blocked' || job.status === 'failed' ? 'text-warning' : 'text-soft-foreground'}><span aria-hidden>● </span>{statusText[job.status]}</p>{job.error ? <p className="mt-1 text-xs text-muted-foreground">{job.error}</p> : null}{job.expiresAt ? <p className="mt-1 text-xs text-muted-foreground">Disponible hasta {new Date(job.expiresAt).toLocaleString('es-ES')}</p> : null}</div>
        {['requested','blocked'].includes(job.status) ? <Button variant="outline" disabled={busy || !evidenceId.trim()} onClick={() => void run(async () => { const data = { restaurantId:rid,jobId:job.id,evidenceId:evidenceId.trim() };await api.verifyPrivacy({ ...data,requestId:requestId(JSON.stringify(data)) });intent.current = null;setNotice('Identidad verificada. La solicitud está preparada para el trabajador local.');await refresh() })}>Verificar identidad</Button> : null}
        {job.kind === 'export' && job.status === 'completed' && job.expiresAt && job.expiresAt > now ? <Button variant="outline" disabled={busy} onClick={() => void run(async () => { const result = await api.downloadExport(rid,job.id);const a = document.createElement('a');a.href = result.url;a.rel = 'noreferrer';a.click() })}><DownloadSimpleIcon aria-hidden />Descargar datos</Button> : null}
      </div>)}</div>}
      {cursor ? <div className="border-t p-4"><Button variant="outline" disabled={busy} onClick={() => void run(() => refresh(true))}>Ver más solicitudes</Button></div> : null}
    </section>
    <SettingsSection id="alcance" title="Qué cubre esta entrega" description="El trabajador local procesa las solicitudes verificadas, aplica la caducidad y deja los bloqueos a la vista.">
      <div className="grid gap-4 text-sm text-muted-foreground sm:grid-cols-3"><p><strong className="block text-foreground">Copias de seguridad</strong>Copia diaria propuesta y simulacro mensual aislado. LogiQD revisa los resultados y los tiempos medidos.</p><p><strong className="block text-foreground">Datos antiguos</strong>Propuesta provisional de 90 días para mensajes y 365 días de inactividad para contactos, notas y alergias.</p><p><strong className="block text-foreground">Fuera de esta herramienta</strong>Dispositivos, archivos ya descargados y proveedores externos necesitan su propio procedimiento de retirada.</p></div>
    </SettingsSection>
    <Dialog open={confirm} onOpenChange={setConfirm}><DialogContent><DialogHeader><DialogTitle>Registrar una solicitud de borrado</DialogTitle><DialogDescription>Tras verificar la identidad se eliminarán o anonimizarán las copias personales que no deban conservarse. El servicio vivo bloquea el proceso y los originales fiscales se conservan restringidos.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirm(false)}>Volver</Button><Button variant="destructive" onClick={() => void submit()}>Registrar solicitud de borrado</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
