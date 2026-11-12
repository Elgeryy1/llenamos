import type { Metadata } from "next"
import { SalaView } from "./SalaView"

export const metadata: Metadata = { title: "Sala" }

// Las páginas del panel esperan a la sesión del navegador (ver layout.tsx).
export const instant = false

export default function SalaPage() {
  return <SalaView />
}
