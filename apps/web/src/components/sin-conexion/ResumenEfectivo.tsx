'use client'

import { useEffect, useState } from 'react'
import type { OfflineCashNote } from '@llenamos/core'
import { usePanel } from '@/components/panel/PanelContext'
import { Notice } from '@/components/common/notice'
import { Button } from '@/components/ui/button'
import { getFirebaseIdentity } from '@/lib/firebase/auth-client'
import { llamarCaja } from '@/lib/caja/api'
import { euros } from '@/lib/caja/modelo'
import { protectSession } from '@/lib/sin-conexion/cliente'
import { mutate, scopeFor } from '@/lib/sin-conexion/almacen'

/** Recupera la respuesta incluso si el cobro ya saldó y ocultó la cuenta de la lista. */
export function ResumenEfectivo() {
  const { restaurant, location, user } = usePanel()
  const [notes, setNotes] = useState<OfflineCashNote[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!location) return
    try { protectSession(scopeFor(restaurant.id, location.id, user.uid)) }
    catch { queueMicrotask(() => setError('No se puede leer el almacenamiento de este dispositivo.')); return }
    let active = true
    const refresh = () => {
      try { void mutate(scopeFor(restaurant.id, location.id, user.uid)).then(s => { if (active) setNotes(s.cash.filter(n => n.status === 'pending_review' && s.cashRequests?.[n.noteId])) }).catch(e => { if (active) setError(e.message) }) }
      catch (e) { if (active) setError(e instanceof Error ? e.message : 'No se puede leer el almacenamiento local.') }
    }
    refresh(); window.addEventListener('llenamos:cola', refresh)
    return () => { active = false; window.removeEventListener('llenamos:cola', refresh) }
  }, [restaurant.id, location, user.uid])
  async function recover(note: OfflineCashNote) {
    if (busy || !navigator.onLine || getFirebaseIdentity().auth.currentUser?.uid !== note.actorUid) return
    setBusy(true); setError('')
    try {
      const payload = (await mutate(note)).cashRequests?.[note.noteId]
      if (!payload) return
      const result = await llamarCaja('registrarCobro', payload)
      await mutate(note, s => ({ ...s, cash: s.cash.map(n => n.noteId === note.noteId ? { ...n, status: 'reconciled', paymentId: result.paymentId } : n) }))
    } catch (e) { setError(e instanceof Error ? e.message : 'No se ha recuperado la respuesta. Conserva la anotación.') }
    finally { setBusy(false) }
  }
  return <>
    {notes.length ? <section className="superficie space-y-3 p-4" aria-label="Cobros anotados por recuperar"><h2 className="text-lg font-semibold">Anotaciones con respuesta por recuperar</h2>{notes.map(n => <div key={n.noteId}><p>{euros(n.amountCents)} de consumo pendiente de confirmar en este dispositivo.</p><Button variant="outline" className="mt-2 h-12" disabled={busy} onClick={() => void recover(n)}>Recuperar la misma operación de efectivo</Button></div>)}</section> : null}
    {error ? <Notice tone="warning">{error}</Notice> : null}
  </>
}
