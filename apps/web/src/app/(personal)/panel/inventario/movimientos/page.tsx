import type { Metadata } from "next"
import { Movimientos } from "@/components/inventario/Movimientos"

export const metadata: Metadata = { title: "Movimientos" }
export const instant = false

export default function Page() {
  return <Movimientos />
}
