import { Suspense } from "react"
import { Caja } from "@/components/caja/Caja"

export const instant = false

export default function Page() {
  return (
    <Suspense fallback={<p>Cargando la caja…</p>}>
      <Caja />
    </Suspense>
  )
}
