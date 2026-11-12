import type { Metadata } from "next"
import { CompartirView } from "./CompartirView"

export const metadata: Metadata = { title: "Compartir" }

// Las páginas del panel esperan a la sesión del navegador (ver layout.tsx).
export const instant = false

export default function Page() {
  return <CompartirView />
}
