import type { Metadata } from "next"
import { ListaEsperaView } from "./ListaEsperaView"

export const metadata: Metadata = { title: "Lista de espera" }

// Las páginas del panel esperan a la sesión del navegador (ver layout.tsx).
export const instant = false

export default function ListaEsperaPage() {
  return <ListaEsperaView />
}
