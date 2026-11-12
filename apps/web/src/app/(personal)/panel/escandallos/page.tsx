import type { Metadata } from "next"
import { Suspense } from "react"
import { Escandallos } from "@/components/inventario/Escandallos"

export const metadata: Metadata = { title: "Escandallos" }
export const instant = false

export default function Page() {
  return (
    <Suspense fallback={<p role="status">Cargando los escandallos…</p>}>
      <Escandallos />
    </Suspense>
  )
}
