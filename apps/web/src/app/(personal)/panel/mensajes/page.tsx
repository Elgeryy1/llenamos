import type { Metadata } from "next"
import { MensajesView } from "./MensajesView"

export const metadata: Metadata = { title: "Mensajes" }

// Las páginas del panel esperan a la sesión del navegador (ver layout.tsx).
export const instant = false

export default function Page() {
  return <MensajesView />
}
