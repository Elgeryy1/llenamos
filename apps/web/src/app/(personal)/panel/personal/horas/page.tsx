import { Suspense } from "react"
import type { Metadata } from "next"
import { Horas } from "@/components/personal/Horas"

export const metadata: Metadata = { title: "Horas del personal" }
export const instant = false

export default function Page() {
  return (
    <Suspense fallback={<p>Cargando…</p>}>
      <Horas />
    </Suspense>
  )
}
