import type { Metadata } from "next"
import { PlanoView } from "./PlanoView"

export const metadata: Metadata = { title: "Plano" }

// Las páginas del panel esperan a la sesión del navegador (ver layout.tsx).
export const instant = false

export default function Page() {
  return <PlanoView />
}
