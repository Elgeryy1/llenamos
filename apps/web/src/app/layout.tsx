import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: { default: "Llenamos", template: "%s · Llenamos" },
  description: "Llenamos by LogiQD: reservas, sala y equipo para tu restaurante.",
}

export const viewport: Viewport = {
  themeColor: "#131209",
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Llenamos solo tiene modo oscuro: la clase «dark» activa las variantes dark: de shadcn.
    <html lang="es" className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster position="bottom-right" />
      </body>
    </html>
  )
}
