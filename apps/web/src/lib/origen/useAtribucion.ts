"use client"

import { attributionFromUrl, hostOf, type ReservationAttributionInput } from "@llenamos/core"
import { useEffect, useState } from "react"

export interface OpcionesAtribucion {
  widget?: boolean
  /** Dominio recibido del contenedor. Se comprueba contra el origen de un mensaje del padre. */
  embedHost?: string | null
}

/** Captura solo la visita actual, sin cookies. null durante SSR: espera antes de enviar la reserva. */
export function useAtribucion({ widget = false, embedHost = null }: OpcionesAtribucion = {}): ReservationAttributionInput | null {
  const [captura, setCaptura] = useState<{ widget: boolean; embedHost: string | null; value: ReservationAttributionInput } | null>(null)
  useEffect(() => {
    const leer = (parentHost: string | null) => {
      const referente = hostOf(document.referrer)
      const referrer = referente ? `https://${referente}` : null
      try {
        return attributionFromUrl(window.location.href, referrer, parentHost)
      } catch {
        // Un parámetro de campaña mal formado no debe impedir reservar. Conserva solo la ruta y los dominios.
        return attributionFromUrl(window.location.origin + window.location.pathname, referrer, parentHost)
      }
    }
    let parentHost = widget ? hostOf(document.referrer) : null
    if (widget && embedHost && hostOf(`https://${embedHost}`) === parentHost) parentHost = hostOf(`https://${embedHost}`)
    queueMicrotask(() => setCaptura({ widget, embedHost, value: leer(parentHost) }))
    if (!widget || window.parent === window) return
    const recibir = (event: MessageEvent) => {
      if (event.source !== window.parent || !event.data || event.data.type !== "llenamos:attribution") return
      const host = hostOf(event.origin)
      if (!host || typeof event.data.embedHost !== "string" || hostOf(`https://${event.data.embedHost}`) !== host) return
      setCaptura({ widget, embedHost, value: leer(host) })
    }
    window.addEventListener("message", recibir)
    // No contiene datos de la visita. El padre responde cuando el gancho ya está escuchando.
    window.parent.postMessage({ type: "llenamos:request-attribution" }, "*")
    return () => window.removeEventListener("message", recibir)
  }, [widget, embedHost])
  return captura?.widget === widget && captura.embedHost === embedHost ? captura.value : null
}
