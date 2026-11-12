/*!
 * Widget de reservas de Llenamos.
 *
 * Pega esto en la web del restaurante, donde quieras el botón:
 *
 *   <script src="https://TU-DOMINIO/widget.js" data-llenamos-slug="taberna-lumbre" async></script>
 *
 * Opciones (atributos del script):
 *   data-llenamos-slug  el restaurante (obligatorio; también vale data-slug)
 *   data-lang     es, ca o en (si no, el idioma del restaurante)
 *   data-mode     "boton" (por defecto: un botón que abre la reserva en una ventana encima de la web),
 *                 "incrustado" (la reserva dentro de la página, donde está el script o en data-target)
 *                 o "ventana" (el botón abre la página de reservas en otra pestaña)
 *   data-target   selector del contenedor para el modo "incrustado"
 *   data-label    texto del botón
 *   data-color    color del botón (por ejemplo #f0a35e)
 *
 * Cualquier elemento con el atributo data-llenamos-reservar abre la reserva. Si la página ya tiene
 * alguno, el modo "boton" no añade su propio botón (se usan esos enlaces).
 * Desde JavaScript: window.Llenamos.abrir().
 *
 * En el móvil, el botón abre la página de reservas completa, que es más cómoda que una ventana.
 * Sin dependencias y sin cookies. La página de dentro comunica su altura y solicita el dominio del contenedor con postMessage.
 */
(function () {
  "use strict"

  var script =
    document.currentScript ||
    (function () {
      var all = document.querySelectorAll("script[src*='widget.js'][data-llenamos-slug], script[src*='widget.js'][data-slug]")
      return all[all.length - 1]
    })()
  if (!script) return

  var origin
  try {
    origin = new URL(script.src, window.location.href).origin
  } catch {
    return
  }

  var slug = (script.getAttribute("data-llenamos-slug") || script.getAttribute("data-slug") || "").trim()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    if (window.console) console.error("Llenamos: falta data-llenamos-slug en el script del widget o no es válido.")
    return
  }

  var lang = (script.getAttribute("data-lang") || "").trim().toLowerCase()
  if (["es", "ca", "en"].indexOf(lang) === -1) lang = ""
  var mode = (script.getAttribute("data-mode") || "boton").trim().toLowerCase()
  var labels = { es: "Reservar mesa", ca: "Reserva taula", en: "Book a table" }
  var closeLabels = { es: "Cerrar", ca: "Tanca", en: "Close" }
  var docLang = (document.documentElement.lang || "").slice(0, 2).toLowerCase()
  var textLang = lang || (labels[docLang] ? docLang : "es")
  var label = script.getAttribute("data-label") || labels[textLang]
  var color = script.getAttribute("data-color") || "#f0a35e"
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) color = "#f0a35e"

  function url(path) {
    var target = new URL(origin + path + "/" + encodeURIComponent(slug))
    if (lang) target.searchParams.set("lang", lang)
    var current = new URL(window.location.href)
    ;["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id", "ad_id", "llc", "gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid"].forEach(function (key) {
      if (current.searchParams.has(key)) target.searchParams.set(key, ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid"].indexOf(key) !== -1 ? "present" : current.searchParams.get(key))
    })
    return target.href
  }
  var widgetUrl = url("/widget")
  var pageUrl = url("/r")

  /* Texto legible encima del color del botón. */
  function inkFor(hex) {
    var n = parseInt(hex.slice(1), 16)
    var rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
      v = v / 255
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    })
    var l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#1a1408" : "#ffffff"
  }

  function makeIframe(title) {
    var iframe = document.createElement("iframe")
    iframe.src = widgetUrl
    iframe.title = title
    iframe.loading = "lazy"
    iframe.setAttribute("allow", "payment; clipboard-write")
    iframe.style.cssText = "display:block;width:100%;height:640px;border:0;background:#131209;color-scheme:dark"
    return iframe
  }

  /* La página de dentro avisa de su altura; solo se escucha a nuestro origen y a nuestro iframe. */
  var frames = []
  window.addEventListener("message", function (event) {
    if (event.origin !== origin || !event.data) return
    if (event.data.type === "llenamos:request-attribution") {
      for (var f = 0; f < frames.length; f++) if (frames[f].iframe.contentWindow === event.source) event.source.postMessage({ type: "llenamos:attribution", embedHost: window.location.hostname }, origin)
      return
    }
    if (event.data.type !== "llenamos:height") return
    var height = Number(event.data.height)
    if (!isFinite(height) || height <= 0) return
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].iframe.contentWindow === event.source) frames[i].onHeight(Math.min(Math.ceil(height), 4000))
    }
  })

  /* Ventana encima de la web ------------------------------------------------ */

  var overlay = null
  var lastFocus = null

  function close() {
    if (!overlay) return
    document.removeEventListener("keydown", onKey, true)
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
    frames = frames.filter(function (f) {
      return f.kind !== "modal"
    })
    overlay = null
    document.documentElement.style.overflow = ""
    if (lastFocus && lastFocus.focus) lastFocus.focus()
  }

  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault()
      close()
    }
  }

  function openModal() {
    if (overlay) return
    lastFocus = document.activeElement
    overlay = document.createElement("div")
    overlay.setAttribute("role", "dialog")
    overlay.setAttribute("aria-modal", "true")
    overlay.setAttribute("aria-label", label)
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(10,9,5,0.72)"
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) close()
    })

    var box = document.createElement("div")
    box.style.cssText =
      "position:relative;width:100%;max-width:640px;max-height:calc(100vh - 32px);overflow:auto;border-radius:12px;border:1px solid rgba(244,241,234,0.12);background:#131209;box-shadow:0 1px 0 rgba(244,241,234,0.05) inset,0 22px 48px -18px rgba(0,0,0,0.8)"

    var closeButton = document.createElement("button")
    closeButton.type = "button"
    closeButton.setAttribute("aria-label", closeLabels[textLang])
    closeButton.textContent = "×"
    closeButton.style.cssText =
      "position:absolute;top:8px;right:8px;z-index:1;width:48px;height:48px;border:0;border-radius:12px;background:#24211b;color:#f4f1ea;font:400 24px/1 system-ui,sans-serif;cursor:pointer"
    closeButton.addEventListener("click", close)

    var iframe = makeIframe(label)
    iframe.loading = "eager"
    iframe.style.paddingTop = "56px"
    frames.push({
      kind: "modal",
      iframe: iframe,
      onHeight: function (h) {
        iframe.style.height = h + "px"
      },
    })

    box.appendChild(closeButton)
    box.appendChild(iframe)
    overlay.appendChild(box)
    document.body.appendChild(overlay)
    document.documentElement.style.overflow = "hidden"
    document.addEventListener("keydown", onKey, true)
    closeButton.focus()
  }

  function openWindow() {
    var opened = window.open(pageUrl, "_blank", "noopener")
    if (!opened) window.location.href = pageUrl
  }

  function open() {
    var narrow = window.matchMedia && window.matchMedia("(max-width: 640px)").matches
    if (mode === "ventana" || narrow) openWindow()
    else openModal()
  }

  /* Montaje -------------------------------------------------------------------- */

  function mountInline() {
    var target = null
    var selector = script.getAttribute("data-target")
    if (selector) {
      try {
        target = document.querySelector(selector)
      } catch {
        target = null
      }
    }
    var iframe = makeIframe(label)
    frames.push({
      kind: "inline",
      iframe: iframe,
      onHeight: function (h) {
        iframe.style.height = h + "px"
      },
    })
    if (target) target.appendChild(iframe)
    else if (script.parentNode) script.parentNode.insertBefore(iframe, script.nextSibling)
  }

  function mountButton() {
    var button = document.createElement("button")
    button.type = "button"
    button.className = "llenamos-reservar"
    button.textContent = label
    button.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border:0;border-radius:12px;font:600 16px/1 system-ui,-apple-system,sans-serif;cursor:pointer;background:" +
      color +
      ";color:" +
      inkFor(color) +
      ";box-shadow:0 1px 0 rgba(244,241,234,0.05) inset,0 1px 2px rgba(0,0,0,0.35),0 10px 28px -14px rgba(0,0,0,0.65)"
    button.addEventListener("click", open)
    if (script.parentNode) script.parentNode.insertBefore(button, script.nextSibling)
  }

  function bindTriggers() {
    var triggers = document.querySelectorAll("[data-llenamos-reservar]")
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getAttribute("data-llenamos-listo")) continue
      triggers[i].setAttribute("data-llenamos-listo", "1")
      triggers[i].addEventListener("click", function (event) {
        event.preventDefault()
        open()
      })
    }
  }

  function start() {
    if (mode === "incrustado") mountInline()
    else if (!document.querySelector("[data-llenamos-reservar]")) mountButton()
    bindTriggers()
  }

  window.Llenamos = { abrir: open, cerrar: close }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start)
  else start()
})()
