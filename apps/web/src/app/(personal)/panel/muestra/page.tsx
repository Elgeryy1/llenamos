import type { Metadata } from "next"
import { MuestraView } from "./MuestraView"

export const metadata: Metadata = { title: "Muestra de componentes" }

// Las páginas del panel esperan a la sesión del navegador (ver ../layout.tsx).
export const instant = false

/** Página interna, sin entrada en el menú: todos los componentes y sus variantes. */
export default function MuestraPage() {
  return <MuestraView />
}
