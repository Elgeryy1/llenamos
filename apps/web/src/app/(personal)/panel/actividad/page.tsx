import type { Metadata } from "next"
import { ActividadView } from "./ActividadView"

export const metadata: Metadata = { title: "Actividad" }

// Las páginas del panel esperan a la sesión del navegador (ver layout.tsx).
export const instant = false

export default function ActividadPage() {
  return <ActividadView />
}
