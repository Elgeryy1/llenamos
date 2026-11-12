import type { Metadata } from "next"
import { ReservasView } from "./ReservasView"

export const metadata: Metadata = { title: "Reservas" }

// Las páginas del panel esperan a la sesión del navegador (ver layout.tsx).
export const instant = false

export default function ReservasPage() {
  return <ReservasView />
}
