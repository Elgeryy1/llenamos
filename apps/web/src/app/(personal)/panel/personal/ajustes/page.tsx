import { Suspense } from "react"
import type { Metadata } from "next"
import { AjustesPersonal } from "@/components/personal/AjustesPersonal"

export const metadata: Metadata = { title: "Ajustes del personal" }
export const instant = false

export default function Page() {
  return (
    <Suspense fallback={<p>Cargando…</p>}>
      <AjustesPersonal />
    </Suspense>
  )
}
