import { InicioView } from "./InicioView"

// Las páginas del panel esperan a la sesión del navegador (ver layout.tsx).
export const instant = false

export default function InicioPage() {
  return <InicioView />
}
