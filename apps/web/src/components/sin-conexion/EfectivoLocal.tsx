'use client'

import { useEffect, useState } from 'react'
import { OFFLINE_MESSAGES, OfflineCashNoteSchema, type CallableInput, type OfflineCashNote } from '@llenamos/core'
import { usePanel } from '@/components/panel/PanelContext'
import { Notice } from '@/components/common/notice'
import { Button } from '@/components/ui/button'
import { protectSession } from '@/lib/sin-conexion/cliente'
import { mutate, scopeFor } from '@/lib/sin-conexion/almacen'
import { getFirebaseIdentity } from '@/lib/firebase/auth-client'
import { llamarCaja } from '@/lib/caja/api'
import { euros } from '@/lib/caja/modelo'

export function EfectivoLocal({ billId, partId, revision, cashSessionId, fresh, amounts }: { billId: string; partId?: string; revision: number; cashSessionId: string; fresh: boolean; amounts: () => { amountCents: number; tipCents: number; tenderedCents: number } }) {
  const { restaurant, location, user } = usePanel()
  const [notes, setNotes] = useState<OfflineCashNote[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [online, setOnline] = useState(true)
  useEffect(() => {
    if (!location) return
    try { protectSession(scopeFor(restaurant.id, location.id, user.uid)) }
    catch { queueMicrotask(() => setError('No se puede guardar efectivo en este dispositivo.')); return }
    let active = true
    const refresh = () => { setOnline(navigator.onLine); void mutate(scopeFor(restaurant.id, location.id, user.uid)).then(s => { if (active) setNotes(s.cash.filter(n => n.billId === billId)) }).catch(e => { if (active) setError(e.message) }) }
    refresh(); window.addEventListener('llenamos:cola', refresh); window.addEventListener('online', refresh); window.addEventListener('offline', refresh)
    return () => { active = false; window.removeEventListener('llenamos:cola', refresh); window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh) }
  }, [restaurant.id, location, user.uid, billId])
  async function save() {
    if (!location || !partId || busy) return
    setBusy(true); setError('')
    try {
      const scope = scopeFor(restaurant.id, location.id, user.uid)
      const note = OfflineCashNoteSchema.parse({ ...scope, noteId: crypto.randomUUID(), billId, partId, expectedRevision: revision, ...amounts(), clientCreatedAt: Date.now(), status: 'pending_review', paymentId: null })
      await mutate(scope, s => {
        if (s.cash.some(n => n.billId === billId && n.partId === partId && n.status === 'pending_review')) throw new Error('Ya hay una anotación pendiente para esta parte. Revísala antes de anotar más efectivo.')
        return { ...s, cash: [...s.cash, note] }
      })
    } catch (e) { setError(e instanceof Error ? e.message : 'No se ha guardado la anotación.') } finally { setBusy(false) }
  }
  async function reconcile(note: OfflineCashNote) {
    if (!online || !fresh || !cashSessionId || busy || getFirebaseIdentity().auth.currentUser?.uid !== note.actorUid) return
    setBusy(true); setError('')
    try {
      // La callable de caja revalida revisión, parte, caja abierta y saldo. Clave estable incluso con respuesta perdida.
      let payload!: CallableInput<'registrarCobro'>
      await mutate(note, s => {
        payload = s.cashRequests?.[note.noteId] ?? { restaurantId: note.restaurantId, locationId: note.locationId, requestId: note.noteId, billId: note.billId, partId: note.partId, expectedRevision: note.expectedRevision, cashSessionId, method: 'cash', amountCents: note.amountCents, tipCents: note.tipCents, tenderedCents: note.tenderedCents, terminalReference: null }
        return { ...s, cashRequests: { ...s.cashRequests, [note.noteId]: payload } }
      })
      const result = await llamarCaja('registrarCobro', payload)
      await mutate(note, s => ({ ...s, cash: s.cash.map(n => n.noteId === note.noteId ? { ...n, status: 'reconciled', paymentId: result.paymentId } : n) }))
    } catch (e) { setError(e instanceof Error ? e.message : 'No se ha confirmado el cobro. Conserva la anotación y recupera la misma operación.') } finally { setBusy(false) }
  }
  return <section aria-label="Efectivo sin conexión" className="superficie space-y-3 p-4">
    <Notice tone="warning">{OFFLINE_MESSAGES.cash}</Notice>
    {!online || !fresh ? <><p className="text-sm">{OFFLINE_MESSAGES.card}</p><p className="text-sm">{OFFLINE_MESSAGES.fiscal}</p><p className="text-sm">No se puede cerrar la caja, aplicar señales ni devolver sin conexión.</p><Button variant="outline" className="h-12" disabled={!partId || busy} onClick={() => void save()}>Anotar efectivo en este dispositivo</Button></> : null}
    {notes.filter(n => n.status === 'pending_review').map(note => <div className="space-y-2 border-t pt-3" key={note.noteId}>
      <p className="text-sm">Pendiente de revisar · consumo {euros(note.amountCents)} · entrega {euros(note.tenderedCents)} · propina {euros(note.tipCents)}</p>
      <p className="text-xs text-muted-foreground">Comprueba el efectivo real y la cuenta actual. Al confirmar se registra una sola vez con la clave de esta anotación.</p>
      <Button variant="outline" className="h-12" disabled={!online || !fresh || !cashSessionId || busy} onClick={() => void reconcile(note)}>He revisado el efectivo y la cuenta. Registrar cobro</Button>
    </div>)}
    {error ? <Notice tone="error">{error}</Notice> : null}
  </section>
}
