import { Suspense } from "react"
import { ParaLlevar } from "@/components/comandero/ParaLlevar"

export default function Page() {
  return <Suspense fallback={<p>Cargando las recogidas…</p>}><ParaLlevar /></Suspense>
}
