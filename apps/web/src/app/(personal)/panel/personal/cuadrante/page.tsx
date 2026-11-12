import { Suspense } from "react"
import type { Metadata } from "next"
import { Cuadrante } from "@/components/personal/Cuadrante"

export const metadata: Metadata = { title: "Cuadrante del personal" }
export const instant = false

export default function Page() {
  return (
    <Suspense fallback={<p>Cargando…</p>}>
      <Cuadrante />
    </Suspense>
  )
}
