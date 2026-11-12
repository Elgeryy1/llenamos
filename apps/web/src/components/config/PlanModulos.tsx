"use client"

import { MODULE_LABEL, MODULES, PLAN_LABEL } from "@llenamos/core"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/cn"
import type { RestaurantDoc } from "@/lib/data/parse"
import { planStateOf } from "@/lib/logiqd/planes"

/** Plan y módulos del restaurante, solo lectura (los cambia el equipo de LogiQD). */
export function PlanModulos({ restaurant, className }: { restaurant: RestaurantDoc; className?: string }) {
  const st = planStateOf(restaurant)
  return (
    <Card role="region" aria-labelledby="plan-titulo" className={className}>
      <CardHeader>
        <CardTitle>
          <h2 id="plan-titulo">Plan {PLAN_LABEL[st.plan]}</h2>
        </CardTitle>
        <CardDescription>
          {st.legacy
            ? "Tu restaurante aún no tiene un plan asignado: de momento tiene todos los módulos."
            : "Los módulos que incluye tu plan. Para cambiar de plan o activar un módulo, habla con LogiQD."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {MODULES.map((m) => {
            const on = st.active.includes(m)
            const extra = st.overrides[m]
            return (
              <li key={m} className="flex items-center justify-between gap-3 py-2.5 text-sm first:pt-0 last:pb-0">
                <span>{MODULE_LABEL[m]}</span>
                <span className={cn("inline-flex items-center gap-1.5 text-xs", on ? "text-success" : "text-muted-foreground")}>
                  <span aria-hidden className={cn("size-2 rounded-full border", on ? "border-success bg-success" : "border-ash bg-transparent")} />
                  {on ? "activo" : "no incluido"}
                  {extra === true ? " · aparte del plan" : extra === false ? " · apagado aparte" : ""}
                </span>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
