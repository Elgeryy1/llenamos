'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { OnboardingDraftSchema, slugify, WEEKDAYS, MODULE_LABEL, type OnboardingDraft, type PublicPlanDefinition, type CallableOutput } from '@llenamos/core'
import { CheckIcon, ArrowRightIcon } from '@phosphor-icons/react'
import { llamarCore } from '@/lib/data/callables'
import { initialDraft, SERVER_STEPS, STEPS, storageKey, type SavedDraft, type Pending } from '@/lib/alta/draft'
import { Button } from '@/components/ui/button'
import { TextField, SelectField } from '@/components/common/form-fields'
import { TimeSelectField } from '@/components/common/time-select-field'
import { Notice } from '@/components/common/notice'
import { FloorPreview } from './FloorPreview'

const DAYS = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']
const money = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(cents/100)
function readSaved(uid: string): SavedDraft {
  const empty: SavedDraft = { draft: initialDraft(), step: 0, onboardingId: null, revision: null, pending: null }
  try {
    const raw = localStorage.getItem(storageKey(uid))
    if (!raw) return empty
    const saved = JSON.parse(raw) as SavedDraft
    if (!Number.isInteger(saved.step) || saved.step < 0 || saved.step > 6 || !saved.draft || typeof saved.draft.name !== 'string') return empty
    return { ...empty, ...saved }
  } catch { return empty }
}
export function Wizard({ uid, email }: { uid: string; email: string }) {
  const [state, setState] = useState(() => readSaved(uid)), [plans, setPlans] = useState<PublicPlanDefinition[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [storageError, setStorageError] = useState(false), [result, setResult] = useState<CallableOutput<'completarAlta'> | null>(null)
  const { draft, step } = state
  useEffect(() => { let live = true; llamarCore('listarPlanesDisponibles', {}).then(r => { if (live) setPlans(r.plans) }).catch(() => { if (live) setError('No se ha podido cargar el catálogo. Recarga para volver a intentarlo.') }); return () => { live = false } }, [])
  useEffect(() => { try { if (!result) localStorage.setItem(storageKey(uid), JSON.stringify(state)) } catch { queueMicrotask(() => setStorageError(true)) } }, [state, uid, result])
  const change = (patch: Partial<OnboardingDraft>) => setState(s => ({ ...s, draft: { ...s.draft, ...patch } }))
  const floor = draft.floor ?? { areaName: 'Sala', tableCount: 6, seats: 4 }
  const selected = plans.find(p => p.id === draft.planId && p.version === draft.planVersion)
  async function advance() {
    setError(''); setBusy(true)
    try {
      let pending: Pending | null = state.pending
      if (!pending) {
        if (step === 0 && (draft.name.trim().length < 2 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug))) throw new Error('Pon un nombre y una dirección válida para tu restaurante.')
        if (step === 1 && draft.location.name.trim().length < 2) throw new Error('Pon un nombre para el local.')
        if (step >= 2) {
          const { acceptedTermsVersion: _terms, ...operationalDraft } = draft
          void _terms
          const checked = OnboardingDraftSchema.omit({ acceptedTermsVersion: true }).safeParse(operationalDraft)
          if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? 'Revisa los datos antes de continuar.')
        }
        if (step === 6) {
          OnboardingDraftSchema.parse(draft)
          if (!draft.acceptedTermsVersion) throw new Error('Acepta las condiciones de la prueba para continuar.')
          // Guarda también la revisión final antes de aprovisionar. Cada respuesta incierta conserva su petición.
        }
        const { acceptedTermsVersion: acceptedTerms, ...draftWithoutTerms } = draft
        void acceptedTerms
        pending = { name: 'guardarAlta', input: { requestId: crypto.randomUUID(), onboardingId: state.onboardingId, expectedRevision: state.revision, step: SERVER_STEPS[step] === 'done' ? 'review' : SERVER_STEPS[step] as 'identity'|'location'|'hours'|'plan'|'review', draft: step === 6 ? draft : draftWithoutTerms } }
      }
      localStorage.setItem(storageKey(uid), JSON.stringify({ ...state, pending }))
      setState(s => ({ ...s, pending }))
      if (pending.name === 'guardarAlta') {
        const saved = await llamarCore('guardarAlta', pending.input)
        const next = { ...state, onboardingId: saved.onboardingId, revision: saved.onboarding.revision, pending: null, step: Math.min(6, step+1) }
        if (step !== 6) { setState(next); localStorage.setItem(storageKey(uid), JSON.stringify(next)); return }
        pending = { name: 'completarAlta', input: { onboardingId: saved.onboardingId, expectedRevision: saved.onboarding.revision, requestId: crypto.randomUUID() } }
        const completing = { ...next, pending }
        setState(completing); localStorage.setItem(storageKey(uid), JSON.stringify(completing))
      }
      const completed = await llamarCore('completarAlta', pending.input)
      setResult(completed); localStorage.removeItem(storageKey(uid))
    } catch (cause) {
      const code = (cause as { code?: string }).code
      setError(cause instanceof Error ? cause.message : 'No se ha podido guardar. Reintenta la misma operación.')
      if (!code || ['functions/invalid-argument','functions/already-exists','functions/failed-precondition'].includes(code)) setState(s => ({ ...s, pending: null }))
    } finally { setBusy(false) }
  }
  if (result) return <section className="mx-auto max-w-2xl space-y-6">
    <div className="flex size-14 items-center justify-center rounded-full bg-success/15 text-success"><CheckIcon size={28} /></div>
    <p className="text-sm text-muted-foreground">{draft.name} · {draft.location.name}</p><h1 className="text-3xl font-semibold tracking-tight">Tu restaurante ya está preparado</h1>
    <p className="text-muted-foreground">Tienes {floor.tableCount} mesas, tus horarios y una prueba hasta el {new Date(result.subscription.trialEndsAt!).toLocaleDateString('es-ES')}. Puedes empezar a recibir reservas y preparar tu primer servicio.</p>
    <Notice tone="success">No has añadido ninguna tarjeta ni se ha realizado ningún cargo. La carta opcional queda pendiente de revisar los alérgenos antes de publicarla.</Notice>
    <FloorPreview {...{ count: floor.tableCount, seats: floor.seats, areaName: floor.areaName }} />
    <Button asChild className="h-12"><Link href="/panel">Entrar en mi restaurante <ArrowRightIcon /></Link></Button>
  </section>
  return <div className="grid gap-8 lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-12">
    <aside><p className="mb-5 text-sm text-muted-foreground">Alta del restaurante</p><ol className="flex flex-wrap gap-2 lg:block lg:space-y-2">{STEPS.map((label, i) => <li key={label} aria-current={i===step ? 'step' : undefined} className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${i===step ? 'bg-surface-raised text-foreground shadow-soft' : 'text-muted-foreground'}`}><span className={`cifra flex size-6 shrink-0 items-center justify-center rounded-full border ${i<step ? 'border-success/40 text-success' : i===step ? 'border-primary/50 text-warning' : ''}`}>{i<step ? <CheckIcon size={14} /> : i+1}</span><span>{label}</span></li>)}</ol><p className="mt-6 break-all text-xs text-muted-foreground">Tu acceso: {email}</p><p className="mt-3 text-xs text-muted-foreground">Guardamos el borrador al continuar. Puedes volver desde este dispositivo.</p></aside>
    <section className="min-w-0 space-y-5">
      <div><p className="mb-2 text-sm text-warning">Paso {step+1} de {STEPS.length}</p><h1 className="text-2xl font-semibold tracking-tight sm:text-[32px]">{['Vamos a llenar tu sala', 'Dónde recibirás a tus clientes', 'Haz sitio para tu primer servicio', 'Cuándo abrís las puertas', 'Un primer vistazo a tu carta', 'Empieza sin tarjeta', 'Revisa y abre tu restaurante'][step]}</h1></div>
      {storageError && <Notice tone="warning">No se puede conservar el borrador en este navegador. Permite el almacenamiento antes de continuar.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <form onSubmit={e => { e.preventDefault(); void advance() }} className="superficie overflow-hidden">
        <fieldset disabled={busy || !!state.pending} className="space-y-5 p-5 sm:p-7">
          {step===0 && <><TextField label="Nombre del restaurante" value={draft.name} onChange={e => change({ name: e.target.value, ...(!draft.slug || draft.slug === slugify(draft.name) ? { slug: slugify(e.target.value) } : {}) })} required maxLength={80} autoComplete="organization" /><TextField label="Dirección de tu página de reservas" value={draft.slug} onChange={e => change({ slug: e.target.value })} hint={`Tu enlace será /r/${draft.slug || 'tu-restaurante'}. Comprobaremos que esté libre al terminar.`} required maxLength={60} /></>}
          {step===1 && <>{(['name','address','city','phone'] as const).map((key,i) => <TextField key={key} label={['Nombre del local','Dirección','Ciudad','Teléfono de contacto'][i]} value={draft.location[key]} required={key==='name'} maxLength={key==='address' ? 200 : key==='phone' ? 30 : 80} onChange={e => change({ location: { ...draft.location, [key]: e.target.value } })} />)}</>}
          {step===2 && <><p className="text-sm text-muted-foreground">Preparamos una zona con mesas. Después podrás moverlas, cambiar sus plazas y añadir una terraza desde el editor de plano.</p><div className="grid gap-4 sm:grid-cols-3"><TextField label="Nombre de la zona" value={floor.areaName} maxLength={40} onChange={e => change({ floor: { ...floor, areaName: e.target.value } })} /><TextField label="Número de mesas" type="number" min={1} max={24} value={floor.tableCount} onChange={e => change({ floor: { ...floor, tableCount: Number(e.target.value) } })} /><SelectField label="Plazas por mesa" value={String(floor.seats)} onChange={e => change({ floor: { ...floor, seats: Number(e.target.value) } })}>{[2,4,6,8,10,12].map(n => <option key={n} value={String(n)}>{n} personas</option>)}</SelectField></div><FloorPreview count={floor.tableCount} seats={floor.seats} areaName={floor.areaName} /></>}
          {step===3 && <><p className="text-sm text-muted-foreground">Hora local de Madrid. Son las primeras y últimas llegadas. Cada reserva dura 90 minutos. Puedes ajustar turnos y excepciones más adelante.</p><div className="divide-y">{WEEKDAYS.map((day,i) => <div key={day} className="space-y-3 py-4"><label className="flex items-center gap-3 text-sm font-medium"><input type="checkbox" className="size-4 accent-primary" checked={draft.settings.week[day].length>0} onChange={e => change({ settings: { ...draft.settings, week: { ...draft.settings.week, [day]: e.target.checked ? [{ name: 'Comida', from: '13:00', lastEntry: '15:30' },{ name: 'Cena', from: '20:00', lastEntry: '22:30' }] : [] } } })} />{DAYS[i]} {!draft.settings.week[day].length && <span className="font-normal text-muted-foreground">Cerrado</span>}</label>{draft.settings.week[day].map((shift,index) => <div key={index} className="grid items-center gap-3 pl-7 sm:grid-cols-[70px_1fr_1fr]"><span className="text-xs text-muted-foreground">{shift.name}</span>{(['from','lastEntry'] as const).map(key => <TimeSelectField key={key} label={key==='from' ? 'Primera llegada' : 'Última llegada'} value={shift[key]} onChange={value => change({ settings: { ...draft.settings, week: { ...draft.settings.week, [day]: draft.settings.week[day].map((s,j) => j===index ? { ...s, [key]: value } : s) } } })} />)}</div>)}</div>)}</div></>}
          {step===4 && <><p className="text-sm text-muted-foreground">Este paso es opcional. Añade algunos platos con su precio final en céntimos, IVA incluido. Quedarán en tu carta interna para revisar alérgenos y publicarlos desde Carta.</p>{(draft.menu ?? []).map((item,i) => <div key={i} className="grid items-end gap-3 sm:grid-cols-[1fr_150px_auto]"><TextField label={`Plato ${i+1}`} value={item.name} maxLength={80} required onChange={e => change({ menu: draft.menu!.map((p,j) => i===j ? { ...p, name: e.target.value } : p) })} /><TextField label="Precio en céntimos" type="number" min={0} max={10000000} step={1} required value={item.priceCents} hint={`${(item.priceCents/100).toLocaleString('es-ES')} €`} onChange={e => change({ menu: draft.menu!.map((p,j) => i===j ? { ...p, priceCents: Number(e.target.value) } : p) })} /><Button type="button" variant="ghost" onClick={() => change({ menu: draft.menu!.filter((_,j) => i!==j) })}>Quitar</Button></div>)}<Button type="button" variant="outline" disabled={(draft.menu?.length ?? 0)>=30} onClick={() => change({ menu: [...(draft.menu ?? []), { name: '', priceCents: 0 }] })}>Añadir plato</Button></>}
          {step===5 && <><Notice tone="warning">Propuesta provisional. Planes, precios y límites pendientes de aprobación. No se realiza ningún cargo y no pedimos tarjeta.</Notice><div className="divide-y">{plans.map(p => <label key={`${p.id}:${p.version}`} className={`flex cursor-pointer gap-4 py-5 ${p.id===draft.planId ? 'text-foreground' : 'text-muted-foreground'}`}><input type="radio" name="plan" className="mt-1 size-4 accent-primary" checked={p.id===draft.planId && p.version===draft.planVersion} onChange={() => change({ planId: p.id, planVersion: p.version })} /><span className="flex-1"><span className="font-semibold">{p.name}</span><span className="mt-1 block text-sm">{p.trialDays} días de prueba · {p.limits.locations ?? 'Sin límite de'} {p.limits.locations === 1 ? 'local' : 'locales'} · {p.limits.members ?? 'Sin límite de'} personas</span><span className="mt-1 block text-xs">{p.modules.map(m => MODULE_LABEL[m]).join(', ')}</span></span><span className="text-right"><span className="cifra font-semibold">{money(p.monthlyCents)}</span><span className="block text-xs">al mes sin IVA</span><span className="mt-1 block text-xs">{money(p.annualCents)} al año</span></span></label>)}</div></>}
          {step===6 && <><dl className="divide-y text-sm">{[['Restaurante',draft.name],['Página de reservas',`/r/${draft.slug}`],['Local',`${draft.location.name} · ${draft.location.city}`],['Plano',`${floor.tableCount} mesas de ${floor.seats} plazas`],['Horario',`${WEEKDAYS.filter(d => draft.settings.week[d].length).length} días abiertos por semana`],['Carta',`${draft.menu?.length ?? 0} platos internos pendientes de revisión`],['Prueba',`${selected?.name ?? draft.planId} · ${selected?.trialDays ?? 14} días sin tarjeta`]].map(([label,value]) => <div key={label} className="grid grid-cols-[110px_1fr] gap-3 py-3"><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>)}</dl><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" checked={!!draft.acceptedTermsVersion} onChange={e => change({ acceptedTermsVersion: e.target.checked ? 'alta-provisional-v1' : '' })} required /><span>Acepto las condiciones de la prueba local: el catálogo es provisional, no hay cobro ni renovación de pago automática y el acceso se suspende al terminar la prueba. Los datos se conservan.</span></label><Notice>La facturación de la suscripción no está configurada. No se ha realizado ningún cargo.</Notice></>}
        </fieldset>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t bg-surface-sunken/40 px-5 py-4 sm:px-7"><Button type="button" variant="ghost" disabled={step===0 || busy || !!state.pending} onClick={() => { setState(s => ({ ...s, step: s.step-1 })); setError('') }}>Volver</Button><Button className="h-12" disabled={busy || storageError || !plans.length} type="submit">{busy ? 'Guardando…' : state.pending ? 'Reintentar la misma operación' : step===6 ? 'Crear mi restaurante' : 'Guardar y continuar'}<ArrowRightIcon /></Button></footer>
      </form>
    </section>
  </div>
}
