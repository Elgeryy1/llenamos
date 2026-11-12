/** Imprime una copia del ticket, sin controles ni estilos oscuros de la aplicación. */
export function imprimirTicket(ticket: HTMLElement) {
  const frame = document.createElement("iframe")
  frame.title = "Impresión del ticket de cocina"
  frame.style.cssText = "position:fixed;width:1px;height:1px;right:0;bottom:0;border:0"
  document.body.append(frame)
  const doc = frame.contentDocument
  const win = frame.contentWindow
  if (!doc || !win) { frame.remove(); throw new Error("No se puede abrir la impresión.") }
  const title = doc.createElement("title")
  title.textContent = ticket.getAttribute("aria-label") ?? "Ticket de cocina"
  const style = doc.createElement("style")
  style.textContent = `@page { margin: 12mm } body { color: #000; background: #fff; font: 16px sans-serif }
    article { border: 0 } header { border-bottom: 2px solid #000 } h2 { font-size: 28px }
    li { padding: 10px 0; break-inside: avoid; border-bottom: 1px solid #888 }
    button, input, [data-ticket-controls], .sr-only { display: none !important }
    p { margin: 6px 0; white-space: pre-wrap } h3 { border-bottom: 1px solid #888 }
    ul { list-style: none; padding: 0 }`
  doc.head.append(title, style)
  doc.body.append(ticket.cloneNode(true))
  win.addEventListener("afterprint", () => frame.remove(), { once: true })
  win.focus()
  win.print()
  // Algunos navegadores no emiten afterprint al cancelar el diálogo.
  window.setTimeout(() => frame.remove(), 60_000)
}
