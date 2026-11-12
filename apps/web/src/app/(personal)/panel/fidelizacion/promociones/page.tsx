import { Promociones } from "@/components/fidelizacion/Promociones"

// La sesión de Firebase se resuelve en el navegador, igual que el resto del panel.
export const instant = false

export default function Page() {
  return <Promociones />
}
