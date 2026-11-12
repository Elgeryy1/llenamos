import type { Metadata } from "next"
import { EstacionView } from "@/components/cocina/EstacionView"

export const metadata: Metadata = { title: "Cocina" }
export const instant = false

export default function CocinaPage() {
  return <EstacionView kind="kitchen" />
}
