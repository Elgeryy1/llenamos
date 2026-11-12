"use client"

/**
 * Preferencias pequeñas guardadas en el navegador (qué restaurante y qué local
 * se eligió). Si el navegador no deja guardar, se sigue funcionando sin recordar.
 */
import { useCallback, useSyncExternalStore } from "react"

const listeners = new Set<() => void>()

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  window.addEventListener("storage", onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener("storage", onChange)
  }
}

export function useStoredValue(key: string | null): [string | null, (value: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => (key ? read(key) : null),
    () => null,
  )
  const set = useCallback(
    (next: string) => {
      if (!key) return
      try {
        window.localStorage.setItem(key, next)
      } catch {
        // Modo privado o almacenamiento lleno: no pasa nada, solo no se recuerda.
      }
      listeners.forEach((l) => l())
    },
    [key],
  )
  return [value, set]
}
