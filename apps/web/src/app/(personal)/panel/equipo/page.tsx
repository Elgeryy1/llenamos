import type { Metadata } from "next"
import { EquipoView } from "./EquipoView"

export const metadata: Metadata = { title: "Equipo" }

// Las páginas del panel esperan a la sesión del navegador (ver layout.tsx).
export const instant = false

export default function EquipoPage() {
  return <EquipoView />
}
