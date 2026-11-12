import { notFound } from "next/navigation"
import { EjemplosCampanas } from "@/components/campanas/EjemplosCampanas"
export const metadata = { title: "Fixtures de campañas", robots: { index: false, follow: false } }
export const instant = false
export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound()
  return <EjemplosCampanas />
}
