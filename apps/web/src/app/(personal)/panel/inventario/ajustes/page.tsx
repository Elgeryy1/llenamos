import type { Metadata } from "next"
import { AjustesInventario } from "@/components/inventario/AjustesInventario"

export const metadata: Metadata = { title: "Ajustes del inventario" }
export const instant = false

export default function Page() {
  return <AjustesInventario />
}
