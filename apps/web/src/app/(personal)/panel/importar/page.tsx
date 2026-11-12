import type { Metadata } from "next"
import { ImportarView } from "./ImportarView"

export const metadata: Metadata = { title: "Importar reservas" }

// Las páginas del panel esperan a la sesión del navegador (ver layout.tsx).
export const instant = false

export default function ImportarPage() {
  return <ImportarView />
}
