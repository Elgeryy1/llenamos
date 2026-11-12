import type { Metadata } from "next"
import { LogiqdView } from "./LogiqdView"

export const metadata: Metadata = {
  title: "Equipo LogiQD",
  robots: { index: false, follow: false },
}

// La sesión y el claim `logiqd` se comprueban en el navegador; las reglas y `cambiarPlan` lo vuelven a comprobar.
export const instant = false

export default function LogiqdPage() {
  return <LogiqdView />
}
