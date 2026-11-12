"use client"

import { ClockCounterClockwiseIcon } from "@phosphor-icons/react"
import { useState } from "react"
import { ActivityTimeline } from "@/components/common/activity-timeline"
import { EmptyState } from "@/components/common/empty-state"
import { LiveIndicator, LoadingBlock } from "@/components/common/loading"
import { LiveError } from "@/components/panel/LiveError"
import { PageHeading } from "@/components/common/page-heading"
import { usePanel } from "@/components/panel/PanelContext"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { activityAvailable } from "@/lib/data/backend"
import { useActivity } from "@/lib/data/hooks"
import type { ActivityDoc } from "@/lib/data/parse"
import { useNow } from "@/lib/use-now"

const PAGE = 30
const dia = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long" })

/** Agrupa las entradas por día: «Hoy», «Ayer» o «lunes 2 de noviembre». */
function porDia(entries: ActivityDoc[], now: Date): Array<{ key: string; label: string; entries: ActivityDoc[] }> {
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  const today = key(now)
  const yesterday = key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const groups: Array<{ key: string; label: string; entries: ActivityDoc[] }> = []
  for (const a of entries) {
    const k = a.createdAt ? key(a.createdAt) : "sin-fecha"
    let g = groups.find((x) => x.key === k)
    if (!g) {
      const label = !a.createdAt ? "Sin fecha" : k === today ? "Hoy" : k === yesterday ? "Ayer" : dia.format(a.createdAt)
      g = { key: k, label: label.charAt(0).toUpperCase() + label.slice(1), entries: [] }
      groups.push(g)
    }
    g.entries.push(a)
  }
  return groups
}

export function ActividadView() {
  return (
    <RequirePermission permission="actividad.ver" what="la actividad">
      {activityAvailable() ? <Actividad /> : <SinRegistro />}
    </RequirePermission>
  )
}

/** En el VPS no hay un registro común: se dice con claridad, sin enseñar un error. */
function SinRegistro() {
  const { restaurant } = usePanel()
  return (
    <>
      <PageHeading eyebrow={`${restaurant.name} · Actividad`} title="Cada cambio tiene su historia" description="Registro de lo que se cambia en el restaurante." />
      <EmptyState
        icon={<ClockCounterClockwiseIcon />}
        title="Aquí todavía no hay un registro común"
        description="Cada parte del restaurante guarda su propio historial: fichajes, existencias, caja y sincronización. Un registro general de todos los cambios no está disponible en esta versión."
      />
    </>
  )
}

function Actividad() {
  const { restaurant } = usePanel()
  const [max, setMax] = useState(PAGE)
  const activity = useActivity(restaurant.id, max)
  const now = useNow()

  // Mientras llega la página siguiente se siguen enseñando las entradas que ya había.
  const [shown, setShown] = useState<ActivityDoc[]>([])
  const [shownKey, setShownKey] = useState<string | null>(null)
  const key = `${restaurant.id}:${max}`
  if (activity.status === "ready" && (shownKey !== key || shown !== activity.data)) {
    setShown(activity.data)
    setShownKey(key)
  }
  const sameRestaurant = shownKey?.startsWith(`${restaurant.id}:`) ?? false
  const entries = activity.status === "ready" ? activity.data : sameRestaurant ? shown : []
  const loadingMore = activity.status === "loading" && entries.length > 0
  const hasMore = activity.status === "ready" && activity.data.length >= max
  const groups = porDia(entries, now)

  return (
    <>
      <PageHeading
        eyebrow={`${restaurant.name} · Actividad`}
        title="Cada cambio tiene su historia"
        description="Registro de lo que se cambia en el restaurante. Nadie puede borrarlo ni editarlo."
        actions={activity.status === "ready" ? <LiveIndicator /> : undefined}
      />

      {activity.status === "error" ? (
        <LiveError title="No se ha podido cargar la actividad" error={activity.error} />
      ) : activity.status === "loading" && entries.length === 0 ? (
        <Card className="superficie rounded-[12px] shadow-soft ring-0 sm:rounded-[14px]">
          <CardContent>
            <LoadingBlock label="Cargando la actividad…" className="flex flex-col gap-5">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-6 rounded-full" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
              ))}
            </LoadingBlock>
          </CardContent>
        </Card>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<ClockCounterClockwiseIcon />}
          title="Aún no hay actividad"
          description="Cuando alguien cambie el restaurante, el equipo o las mesas, aparecerá aquí al momento."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <Card key={g.key} className="superficie gap-5 rounded-[12px] shadow-soft ring-0 sm:rounded-[14px]">
              <CardHeader className="border-b">
                <CardTitle className="flex items-center justify-between gap-3 text-base font-semibold">{g.label}<span className="cifra text-xs font-normal text-muted-foreground">{g.entries.length} cambios</span></CardTitle>
              </CardHeader>
              <CardContent>
                <ActivityTimeline entries={g.entries} now={now} label={`Actividad: ${g.label}`} />
              </CardContent>
            </Card>
          ))}
          {hasMore || loadingMore ? (
            <div>
              <Button variant="outline" disabled={loadingMore} aria-busy={loadingMore || undefined} onClick={() => setMax((m) => m + PAGE)}>
                {loadingMore ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
                {loadingMore ? "Cargando…" : "Ver más"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </>
  )
}
