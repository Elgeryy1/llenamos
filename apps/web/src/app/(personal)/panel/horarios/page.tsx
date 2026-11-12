import type { Metadata } from "next"
import { HorariosView } from "./HorariosView"

export const metadata: Metadata = { title: "Horarios y reservas" }

// Las páginas del panel esperan a la sesión del navegador (ver layout.tsx).
export const instant = false

export default function Page() {
  return <HorariosView />
}
