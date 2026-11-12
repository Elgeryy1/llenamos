import { Suspense } from "react"
import { Comandero } from "@/components/comandero/Comandero"

export const instant = false

export default function Page() {
  return <Suspense fallback={<p>Cargando el comandero…</p>}><Comandero /></Suspense>
}
