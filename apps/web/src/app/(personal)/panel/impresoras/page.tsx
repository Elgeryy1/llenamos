import { Suspense } from "react"
import { Impresoras } from "@/components/impresion/Impresoras"
export const instant = false
export default function Page() {
  return <Suspense fallback={<p>Cargando las impresoras…</p>}><Impresoras /></Suspense>
}
