"use client"

import { useEffect, useState } from "react"
import { MODULE_LABEL, type CallableOutput } from "@llenamos/core"
import { usePanel } from "@/components/panel/PanelContext"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { PageHeading } from "@/components/common/page-heading"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Notice } from "@/components/common/notice"
import { llamarCore } from "@/lib/data/callables"
import { SUBSCRIPTION_LABEL, formatMoney } from "@/lib/planes/presentation"

export function Planes() {
  const { restaurant } = usePanel()
  return <RequirePermission permission="planes.ver" what="la suscripción"><SubscriptionView key={restaurant.id} /></RequirePermission>
}

function SubscriptionView() {
  const { restaurant } = usePanel()
  const [current, setCurrent] = useState<CallableOutput<"verSuscripcion"> | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    let live = true
    llamarCore("verSuscripcion", { restaurantId: restaurant.id }).then(result => { if (live) setCurrent(result) }).catch(error => { if (live) setError(error instanceof Error ? error.message : "No se ha podido cargar el plan.") })
    return () => { live = false }
  }, [restaurant.id])
  return <div className="space-y-6">
    <PageHeading eyebrow="Restaurante" title="Plan y facturación" description="Consulta tu plan y los módulos contratados. LogiQD gestiona los cambios y las condiciones de tu servicio." />
    {error ? <Notice tone="error">{error}</Notice> : !current ? <p role="status">Cargando tu plan…</p> : <>
      <SummaryStrip label="Tu suscripción" items={[{ label: "Plan actual", value: current.plan.name }, { label: "Estado", value: SUBSCRIPTION_LABEL[current.subscription.status] }, { label: "Precio mensual", value: formatMoney(current.plan.monthlyCents), hint: "Sin IVA; según tus condiciones contratadas" }]} />
      <section className="superficie space-y-4 p-5"><h2 className="font-semibold">Módulos de tu restaurante</h2><div className="flex flex-wrap gap-3">{current.entitlements.activeModules.length ? current.entitlements.activeModules.map(module => <span key={module} className="rounded-md bg-success/10 px-3 py-2 text-sm text-success">{MODULE_LABEL[module]}</span>) : <p className="text-sm text-muted-foreground">No hay módulos operativos habilitados. Los datos no se borran.</p>}</div></section>
      <Notice tone="info">Para cambiar el plan, activar módulos o consultar la facturación, contacta con <a href="mailto:hola@logiqd.me" className="underline">hola@logiqd.me</a>. No se realiza ningún cambio ni cargo desde esta pantalla.</Notice>
    </>}
  </div>
}
