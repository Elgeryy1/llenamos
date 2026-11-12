"use client"

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react"

/**
 * Atajos de teclado del panel.
 *
 * Una tecla sola («n», «/», «t») solo cuenta si no se está escribiendo en un campo y no
 * hay una ventana abierta; las combinaciones con ⌘ o Ctrl («mod+k») cuentan siempre.
 * Como el efecto se limpia cuando Next oculta la página (<Activity>), una página oculta
 * no escucha teclas.
 */
/** Devolver false deja pasar la tecla al navegador (por ejemplo, desplazar el tiempo). */
export type HotkeyHandler = (event: KeyboardEvent) => void | boolean

export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === "TEXTAREA" || tag === "SELECT") return true
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type
    return !["checkbox", "radio", "button", "submit", "reset"].includes(type)
  }
  return false
}

/** ¿Hay un diálogo, un panel lateral o un menú abiertos? */
export function overlayOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !== null
}

/** «mod+k», «shift+/», «n», «arrowleft». */
export function keyOf(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push("mod")
  if (e.altKey) parts.push("alt")
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()
  // «?» ya implica mayúsculas: no se añade shift para los símbolos.
  if (e.shiftKey && e.key.length > 1) parts.push("shift")
  parts.push(key)
  return parts.join("+")
}

export function useHotkeys(bindings: Record<string, HotkeyHandler>, enabled = true) {
  const ref = useRef(bindings)
  useLayoutEffect(() => {
    ref.current = bindings
  })
  useEffect(() => {
    if (!enabled) return
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return
      const key = keyOf(e)
      const handler = ref.current[key]
      if (!handler) return
      const withMod = key.startsWith("mod+")
      if (!withMod && (isTyping(e.target) || overlayOpen())) return
      if (handler(e) !== false) e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [enabled])
}

const subscribeNoop = () => () => {}

/** En Mac se enseña ⌘; en el resto, Ctrl. */
export function useIsMac(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent),
    () => false,
  )
}
