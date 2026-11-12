import type { Metadata } from "next"
import { ClientesView } from "./ClientesView"

export const metadata: Metadata = { title: "Clientes" }

// Las páginas del panel esperan a la sesión del navegador (ver layout.tsx).
export const instant = false

export default function ClientesPage() {
  return <ClientesView />
}
