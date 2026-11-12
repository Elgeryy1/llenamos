import type { Metadata } from "next"
import { EstacionView } from "@/components/cocina/EstacionView"

export const metadata: Metadata = { title: "Barra" }
export const instant = false

export default function BarraPage() {
  return <EstacionView kind="bar" />
}
