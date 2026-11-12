import { Suspense } from "react"
import type { Metadata } from "next"
import { Fichaje } from "@/components/personal/Fichaje"

export const metadata: Metadata = { title: "Fichaje" }
export const instant = false

export default function Page() {
  return (
    <Suspense fallback={<p>Cargando el fichaje…</p>}>
      <Fichaje />
    </Suspense>
  )
}
