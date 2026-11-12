import { Suspense } from "react"
import type { Metadata } from "next"
import { Puesto } from "@/components/personal/Puesto"

export const metadata: Metadata = { title: "Puesto de fichaje" }
export const instant = false

export default function Page() {
  return (
    <Suspense fallback={<p>Cargando el puesto de fichaje…</p>}>
      <Puesto />
    </Suspense>
  )
}
