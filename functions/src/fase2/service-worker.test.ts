import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

it('el trabajador muestra solo tareas, no renotifica y abre el enlace protegido en la ventana existente', async () => {
  const handlers: Record<string, (event: object) => void> = {}
  const show = vi.fn().mockResolvedValue(undefined), navigate = vi.fn().mockResolvedValue(undefined), focus = vi.fn().mockResolvedValue(undefined), openWindow = vi.fn()
  const self = { location: { origin: 'https://llenamos.example.test' }, registration: { showNotification: show }, addEventListener: (name: string, fn: (event: object) => void) => { handlers[name] = fn }, clients: { matchAll: vi.fn().mockResolvedValue([{ url: 'https://llenamos.example.test/panel/cocina', navigate, focus }]), openWindow } }
  runInNewContext(readFileSync(new URL('../../../apps/web/public/sw-avisos.js', import.meta.url), 'utf8'), { self, URL })
  const promises: Promise<unknown>[] = [], waitUntil = (p: Promise<unknown>) => promises.push(p)
  const data = { title: 'Mesa C2', body: 'Hay una tarea retrasada', tag: 'task:r:l:t', url: '/panel/avisos?task=t&restaurant=r&local=l' }
  handlers.push!({ data: { json: () => data }, waitUntil })
  await Promise.all(promises)
  expect(show).toHaveBeenCalledWith('Mesa C2', expect.objectContaining({ tag: 'task:r:l:t', renotify: false, data: { url: 'https://llenamos.example.test/panel/avisos?task=t&restaurant=r&local=l' } }))
  handlers.push!({ data: { json: () => ({ ...data, url: 'https://ajeno.example.test/panel/avisos' }) }, waitUntil })
  expect(show).toHaveBeenCalledOnce()
  const close = vi.fn()
  handlers.notificationclick!({ notification: { data: { url: data.url }, close }, waitUntil })
  await Promise.all(promises)
  expect(close).toHaveBeenCalledOnce(); expect(navigate).toHaveBeenCalledWith('https://llenamos.example.test/panel/avisos?task=t&restaurant=r&local=l'); expect(focus).toHaveBeenCalledOnce(); expect(openWindow).not.toHaveBeenCalled()
})
