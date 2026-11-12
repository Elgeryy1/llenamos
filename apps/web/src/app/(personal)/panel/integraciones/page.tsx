import type { Metadata } from "next"
import { IntegracionesView } from "@/components/integraciones/IntegracionesView"
export const metadata: Metadata = { title: "Integraciones", robots: { index: false, follow: false } }
export const instant = false
export default function IntegracionesPage() { return <IntegracionesView /> }
