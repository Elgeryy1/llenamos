import type { ReactNode } from "react"
import { MarcoFidelizacion } from "@/components/fidelizacion/Marco"

// La sesión de Firebase se resuelve en el navegador, igual que el resto del panel.
export const instant = false

export default function Layout({ children }: { children: ReactNode }) {
  return <MarcoFidelizacion>{children}</MarcoFidelizacion>
}
