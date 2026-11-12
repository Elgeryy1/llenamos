import type { Metadata } from "next"
import { Recuento } from "@/components/inventario/Recuento"

export const metadata: Metadata = { title: "Recuento" }
export const instant = false

export default function Page() {
  return <Recuento />
}
