"use client"

import { useEffect, useState } from "react"

/** Hora actual que avanza sola (cada minuto por defecto), para que «hace 5 min» no se quede quieto. */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}
