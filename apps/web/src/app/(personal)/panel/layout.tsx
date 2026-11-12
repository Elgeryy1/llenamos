import type { Metadata } from "next"
import { PanelGate } from "@/components/panel/PanelGate"

export const metadata: Metadata = {
  title: { default: "Panel", template: "%s · Panel · Llenamos" },
  robots: { index: false, follow: false },
}

// La sesión vive en el navegador (Firebase Auth): hasta saber quién entra, el
// panel enseña su esqueleto y no pinta la página. Por eso la primera entrada al
// panel no puede ser instantánea; dentro, las páginas cambian sin esperar al servidor.
export const instant = false

export default function PanelLayout({ children }: LayoutProps<"/panel">) {
  return <PanelGate>{children}</PanelGate>
}
