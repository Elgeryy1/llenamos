import type { Metadata } from "next"
import { Suspense } from "react"
import { Analisis } from "@/components/analisis/Analisis"

export const metadata: Metadata = { title: "Análisis" }
export const instant = false

export default function Page() {
  return <Suspense fallback={<p role="status">Cargando el análisis…</p>}><Analisis /></Suspense>
}
