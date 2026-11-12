import type { Metadata } from "next"
import { AjustesView } from "./AjustesView"

export const metadata: Metadata = { title: "Ajustes" }

// Las páginas del panel esperan a la sesión del navegador (ver layout.tsx).
export const instant = false

export default function AjustesPage() {
  return <AjustesView />
}
