"use client"

import { ChartBarIcon, CloudSunIcon, EnvelopeSimpleIcon, LightningIcon } from "@phosphor-icons/react"
import { useSearchParams, useRouter } from "next/navigation"
import { usePanel } from "@/components/panel/PanelContext"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { RequireModule } from "@/components/panel/RequireModule"
import { PageHeading } from "@/components/common/page-heading"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Ventas } from "./Ventas"
import { Prevision } from "./Prevision"
import { Resumen } from "./Resumen"
import { Automatizaciones } from "./Automatizaciones"

const VISTAS = [{ id: "ventas", label: "Ventas y sala", Icono: ChartBarIcon }, { id: "prevision", label: "Previsión", Icono: CloudSunIcon }, { id: "resumen", label: "Resumen diario", Icono: EnvelopeSimpleIcon }, { id: "reglas", label: "Recomendaciones", Icono: LightningIcon }]

export function Analisis() {
  return <RequirePermission permission="analisis.ver" what="el análisis"><RequireModule module="analytics"><Contenido /></RequireModule></RequirePermission>
}
function Contenido() {
  const { restaurant, location, user } = usePanel()
  const params = useSearchParams(), router = useRouter()
  const vista = VISTAS.find((v) => v.id === params.get("vista"))?.id ?? "ventas"
  const ejemplo = process.env.NEXT_PUBLIC_USE_EMULATORS === "1" && params.get("ejemplo") === "1"
  return <div className="space-y-5">
    <PageHeading title="Las cifras de tu sala" eyebrow={`${restaurant.name} · ${location?.name ?? "Todos los locales"}`} description="Lo que ha pasado en el servicio y lo que puedes preparar para los próximos días." />
    <nav aria-label="Análisis" className="flex gap-1 overflow-x-auto pb-1">{VISTAS.map(({ id, label, Icono }) => <Button key={id} variant={vista === id ? "secondary" : "ghost"} className="min-h-11 shrink-0" aria-pressed={vista === id} onClick={() => { const next = new URLSearchParams(params); next.set("vista", id); router.replace(`/panel/analisis?${next}`) }}><Icono aria-hidden />{label}</Button>)}</nav>
    {ejemplo ? <Notice tone="warning" title="Ejemplo de diseño con fixtures">Estas cifras son inventadas. No son datos del restaurante. Guardar, exportar y resolver recomendaciones están desactivados. <a className="underline" href={`/panel/analisis?vista=${vista}`}>Consultar datos reales</a></Notice> : null}
    <div key={`${restaurant.id}:${location?.id}:${user.uid}:${ejemplo}:${vista}`}>
      {vista === "ventas" ? <Ventas ejemplo={ejemplo} /> : vista === "prevision" ? <Prevision ejemplo={ejemplo} /> : vista === "resumen" ? <Resumen ejemplo={ejemplo} /> : <Automatizaciones ejemplo={ejemplo} />}
    </div>
  </div>
}
