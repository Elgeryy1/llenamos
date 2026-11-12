"use client"

import { useEffect, useRef, useState } from "react"
import type { TicketLine } from "@llenamos/core"
import { nuevosRetrasos } from "./modelo"

/** Solo mientras la pantalla está visible y solo al cruzar el plazo. */
export function useAvisos(lines: readonly TicketLine[], enabled: boolean, now: number) {
  const lastCheck = useRef<number | null>(null)
  const [announcement, setAnnouncement] = useState("")
  useEffect(() => {
    const reset = () => { lastCheck.current = null }
    reset()
    document.addEventListener("visibilitychange", reset)
    return () => {
      reset()
      document.removeEventListener("visibilitychange", reset)
    }
  }, [])
  useEffect(() => {
    const previous = lastCheck.current
    lastCheck.current = now
    if (!enabled || previous === null || document.visibilityState !== "visible") return
    const alerts = nuevosRetrasos(lines, previous, now)
    if (!alerts.length) return
    navigator.vibrate?.([180, 80, 180])
    // El anuncio cambia solo cuando empieza un retraso, no con cada tic del reloj.
    queueMicrotask(() => setAnnouncement(`${alerts.length} ${alerts.length === 1 ? "plato acaba" : "platos acaban"} de superar el tiempo de preparación.`))
  }, [lines, enabled, now])
  return announcement
}
