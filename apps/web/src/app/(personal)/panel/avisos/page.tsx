import { Suspense } from "react"
import { TareaAviso } from "@/components/avisos/TareaAviso"

export const instant = false

export default function Page() {
  return <Suspense fallback={<p>Consultando aviso…</p>}><TareaAviso /></Suspense>
}
