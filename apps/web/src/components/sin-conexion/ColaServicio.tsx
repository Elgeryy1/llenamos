'use client'

import { useEffect, useState } from 'react'
import { usePanel } from '@/components/panel/PanelContext'
import { Notice } from '@/components/common/notice'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { mutate, scopeFor, type Espacio } from '@/lib/sin-conexion/almacen'
import { discard, drain, prepare, protectSession, type ObservedEntity } from '@/lib/sin-conexion/cliente'

export function ColaServicio({ entities = [], kitchen = false }: { entities?: ObservedEntity[]; kitchen?: boolean }) {
  const { user, restaurant, location } = usePanel()
  const [space, setSpace] = useState<Espacio | null>(null)
  const [online, setOnline] = useState(true)
  const [error, setError] = useState('')
  const [reason, setReason] = useState('')
  const entityKey = JSON.stringify(entities)
  useEffect(() => {
    if (!location) return
    let scope: ReturnType<typeof scopeFor>
    try { scope = scopeFor(restaurant.id, location.id, user.uid); protectSession(scope) }
    catch { queueMicrotask(() => setError('No se puede preparar el almacenamiento local. No se guardarán intenciones en este dispositivo.')); return }
    let active = true
    const refresh = () => { navigator.serviceWorker?.controller?.postMessage({ type: 'llenamos:network', offline: !navigator.onLine }); setOnline(navigator.onLine); void mutate(scope).then(s => { if (active) setSpace(s) }).catch(e => { if (active) setError(String(e.message)) }) }
    const sync = () => { refresh(); void drain(scope).catch(e => { if (active) setError(String(e.message)) }) }
    const ready = () => {
      if (navigator.onLine) void prepare(scope, JSON.parse(entityKey)).catch(e => { if (active) setError(e instanceof Error ? e.message : 'No se ha podido preparar la pantalla.') })
    }
    ready(); sync()
    const timer = setInterval(sync, 3000), preparation = setInterval(ready, 15000)
    window.addEventListener('llenamos:cola', refresh)
    window.addEventListener('online', sync)
    window.addEventListener('offline', refresh)
    return () => { active = false; clearInterval(timer); clearInterval(preparation); window.removeEventListener('llenamos:cola', refresh); window.removeEventListener('online', sync); window.removeEventListener('offline', refresh) }
  }, [user.uid, restaurant.id, location, entityKey])
  const pending = space?.entries.filter(e => !['applied', 'discarded'].includes(e.state)) ?? []
  return <section aria-label="Sin conexión" className="superficie space-y-3 p-4">
    <p className="font-medium">{online ? 'Conexión disponible' : 'Sin conexión'} · Cambios pendientes: {pending.length}</p>
    <p className="text-sm text-muted-foreground">{kitchen ? 'Los cambios locales esperan aquí. Sala no los recibe hasta sincronizar.' : 'Los pedidos locales esperan aquí. Cocina y caja no los reciben hasta sincronizar.'} Sin internet, avisa al equipo de palabra o en papel.</p>
    <p className="text-xs text-muted-foreground">{space?.synchronizedAt ? `Última revisión del servidor: ${new Date(space.synchronizedAt).toLocaleString('es-ES')}` : 'Abre y prepara esta pantalla con conexión antes de un corte.'} La cola queda bloqueada para tu cuenta al salir. Borrar los datos del navegador puede perder intenciones pendientes.</p>
    {error ? <Notice tone="warning">{error}</Notice> : null}
    {pending.map(e => <div key={e.command.commandId} className="space-y-2 border-t pt-3">
      <p className="text-sm">Cambio {e.command.sequence} · {({ enviarPedido: "Pedido", marcharPase: "Marchar pase", cambiarEstadoLineas: "Estado de platos", cambiarEstadoTarea: "Tarea de sala", marcarAgotado: "Disponibilidad" })[e.command.operation]} · {({ queued: 'Pendiente de sincronizar', sending: 'Esperando respuesta', uncertain: 'Respuesta por recuperar', retry: 'Pendiente de reintento', conflict: 'Conflicto que necesita revisión', rejected: 'Envío bloqueado', applied: 'Confirmada', discarded: 'Descartada' })[e.state]}</p>
      <p className="text-sm text-warning">{e.result && 'message' in e.result ? e.result.message : e.lastError}</p>
      {['conflict', 'rejected'].includes(e.state) ? <>
        <p className="text-sm">Consulta el estado actual antes de descartar. Si sigue siendo necesario, crea otra intención con los datos revisados.</p>
        <Input aria-label="Motivo del descarte" placeholder="Explica la revisión y el motivo" value={reason} onChange={event => setReason(event.target.value)} maxLength={200} />
        <Button variant="outline" className="h-12" disabled={!online || !reason.trim()} onClick={() => { if (!location) return; void discard(scopeFor(restaurant.id, location.id, user.uid), e.command, reason).then(() => setReason('')).catch(err => setError(err.message)) }}>Descartar tras revisar</Button>
      </> : null}
    </div>)}
    {pending.length ? <Button variant="outline" className="h-12" disabled={!online} onClick={() => { if (location) void drain(scopeFor(restaurant.id, location.id, user.uid), true) }}>Recuperar y sincronizar pendientes</Button> : null}
  </section>
}
