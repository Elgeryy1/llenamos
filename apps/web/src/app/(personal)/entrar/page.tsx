import type { Metadata } from "next"
import { Suspense } from "react"
import { EntrarView, EntrarFallback } from "./EntrarView"

export const metadata: Metadata = {
  title: "Entrar",
  robots: { index: false, follow: false },
}

export default function EntrarPage() {
  // El formulario lee ?siguiente= de la URL: va dentro de Suspense para que el
  // resto de la página se pueda generar de antemano.
  return (
    <Suspense fallback={<EntrarFallback />}>
      <EntrarView />
    </Suspense>
  )
}
