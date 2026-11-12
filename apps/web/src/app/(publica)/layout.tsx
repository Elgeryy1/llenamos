import type { Metadata, Viewport } from "next"

/**
 * Web pública de reservas (`/r/...` y `/widget/...`): sin sesión ni panel. Cada página
 * pone el idioma, la marca del restaurante y sus metadatos.
 */
export const metadata: Metadata = {
  // Para que las imágenes de compartir lleven la dirección completa.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
}

export const viewport: Viewport = {
  themeColor: "#131209",
  colorScheme: "dark",
}

export default function PublicaLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh flex-col bg-background">{children}</div>
}
