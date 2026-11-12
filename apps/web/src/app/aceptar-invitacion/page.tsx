import { Suspense } from "react"
import type { Metadata } from "next"
import { AcceptInvitation } from "./view"

export const metadata: Metadata = { title: "Aceptar invitación", robots: { index: false, follow: false } }
export default function Page() {
  return <Suspense fallback={<p role="status">Cargando invitación…</p>}><AcceptInvitation /></Suspense>
}
