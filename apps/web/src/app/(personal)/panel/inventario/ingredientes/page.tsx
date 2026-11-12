import type { Metadata } from "next"
import { Ingredientes } from "@/components/inventario/Ingredientes"

export const metadata: Metadata = { title: "Ingredientes" }
export const instant = false

export default function Page() {
  return <Ingredientes />
}
