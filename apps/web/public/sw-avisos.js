/* Avisos Web Push. No guarda páginas ni datos del servicio en caché. */
self.addEventListener("push", event => {
  if (!event.data) return
  let data
  try { data = event.data.json() } catch { return }
  if (typeof data.tag !== "string" || !data.tag.startsWith("task:")) return
  const url = new URL(data.url, self.location.origin)
  if (url.origin !== self.location.origin || url.pathname !== "/panel/avisos") return
  event.waitUntil(self.registration.showNotification(data.title || "Tarea con retraso", {
    body: data.body, tag: data.tag, renotify: false, vibrate: [180, 80, 180],
    icon: "/icon.svg", data: { url: url.href },
  }))
})
self.addEventListener("notificationclick", event => {
  event.notification.close()
  const url = new URL(event.notification.data.url, self.location.origin)
  if (url.origin !== self.location.origin || url.pathname !== "/panel/avisos") return
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async clients => {
    const client = clients.find(c => new URL(c.url).origin === self.location.origin && new URL(c.url).pathname.startsWith("/panel"))
    if (client) { await client.navigate(url.href); await client.focus() }
    else await self.clients.openWindow(url.href)
  }))
})
