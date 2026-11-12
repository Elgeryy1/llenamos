import { Suspense } from "react"
import type { Metadata } from "next"
import { Hoy } from "@/components/personal/Hoy"

export const metadata: Metadata = { title: "Personal" }
export const instant = false

export default function Page() {
  return (
    <Suspense fallback={<p>Cargando al personal…</p>}>
      <Hoy />
    </Suspense>
  )
}
