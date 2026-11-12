import type { Metadata } from "next"
import { Existencias } from "@/components/inventario/Existencias"

export const metadata: Metadata = { title: "Inventario" }
export const instant = false

export default function Page() {
  return <Existencias />
}
