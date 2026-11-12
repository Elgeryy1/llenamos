"use client"

import { can, hasModule, ROLE_LABEL } from "@llenamos/core"
import { ChefHatIcon, CheckCircleIcon, MapPinIcon, PhoneIcon, WineIcon } from "@phosphor-icons/react"
import Link from "next/link"
import { useMemo } from "react"
import { ActivityTimeline } from "@/components/common/activity-timeline"
import { EmptyState } from "@/components/common/empty-state"
import { LoadingBlock } from "@/components/common/loading"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Tag } from "@/components/common/tag"
import { LiveError } from "@/components/panel/LiveError"
import { PageHeading } from "@/components/common/page-heading"
import { usePanel } from "@/components/panel/PanelContext"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { activityAvailable } from "@/lib/data/backend"
import { useActivity, useMembers, useSala } from "@/lib/data/hooks"
import type { AreaDoc, TableDoc } from "@/lib/data/parse"
import { firstName, plural } from "@/lib/format"
import { overlappingTables, tableStats } from "@/lib/sala/plano"
import { useNow } from "@/lib/use-now"

const hoy = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long" })

interface Aviso {
  id: string
  tone: "warning" | "neutro"
  title: string
  detail: string
}

/** Lo que pide atención en el plano, sacado de los datos reales (en la fase 1 se suman las reservas). */
function avisosDelPlano(areas: AreaDoc[], tables: TableDoc[]): Aviso[] {
  const names = new Map(tables.map((t) => [t.id, t.name]))
  const known = new Set(areas.map((a) => a.id))
  const out: Aviso[] = []
  for (const [a, b] of overlappingTables(tables)) {
    out.push({ id: `pisa-${a}-${b}`, tone: "warning", title: `${names.get(a)} y ${names.get(b)} se pisan en el plano`, detail: "Revisa sus posiciones." })
  }
  const orphans = tables.filter((t) => !known.has(t.areaId))
  if (orphans.length > 0) {
    out.push({
      id: "sin-zona",
      tone: "warning",
      title: `${plural(orphans.length, "mesa apunta", "mesas apuntan")} a una zona que no existe`,
      detail: orphans.map((t) => t.name).join(", "),
    })
  }
  const off = tables.filter((t) => !t.enabled)
  if (off.length > 0) {
    out.push({
      id: "deshabilitadas",
      tone: "neutro",
      title: `${plural(off.length, "mesa deshabilitada", "mesas deshabilitadas")}`,
      detail: `${off.map((t) => t.name).join(", ")}. No se ofrecen para reservar.`,
    })
  }
  return out
}

export function InicioView() {
  const { restaurant, location, member, role } = usePanel()
  const seesSala = can(role, "sala.ver") && hasModule(restaurant, "floor")
  const seesTeam = can(role, "equipo.ver")
  const seesActivity = can(role, "actividad.ver") && activityAvailable()
  const now = useNow()

  // Solo se piden los datos que el rol puede ver (las reglas rechazarían el resto).
  const sala = useSala(restaurant.id, seesSala ? (location?.id ?? null) : null)
  const members = useMembers(restaurant.id, seesTeam)
  const activity = useActivity(restaurant.id, 6, seesActivity)

  const name = firstName(member.displayName)
  const stats = sala.status === "ready" ? tableStats(sala.data.tables) : null
  const avisos = useMemo(() => (sala.status === "ready" ? avisosDelPlano(sala.data.areas, sala.data.tables) : []), [sala])
  const activeMembers = members.status === "ready" ? members.data.filter((m) => m.active).length : 0

  // El titular cuenta algo cierto. Cuando haya reservas: «64 cubiertos esta noche».
  const title =
    seesSala && location && stats && stats.enabled > 0
      ? `${plural(stats.enabled, "mesa lista", "mesas listas")} en ${location.name}`
      : name
        ? `Hola, ${name}`
        : "Hola"

  const eyebrow = [hoy.format(now), location?.name].filter(Boolean).join(" · ")

  return (
    <>
      <PageHeading
        eyebrow={eyebrow}
        title={title}
        description={
          <>
            Estás en {restaurant.name} como <span className="text-foreground">{ROLE_LABEL[role].toLowerCase()}</span>.
          </>
        }
        actions={
          <>
            {restaurant.isDemo ? (
              <Badge variant="outline" className="border-primary/30 text-primary">
                Restaurante de demostración
              </Badge>
            ) : null}
            {seesSala ? (
              <Button asChild size="lg" className="shadow-soft">
                <Link href="/panel/sala">Abrir sala</Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="flex flex-col gap-6">
        {seesSala || seesTeam ? (
          <SummaryStrip label="Tu restaurante de un vistazo" items={[
            ...(seesSala ? [
              { label: "Mesas activas", value: sala.status === "error" ? "—" : stats?.enabled ?? 0, loading: sala.status === "loading", hint: stats ? `de ${plural(stats.tables, "mesa", "mesas")} en el plano` : undefined },
              { label: "Plazas", value: sala.status === "error" ? "—" : stats?.seats ?? 0, loading: sala.status === "loading", hint: "en las mesas activas" },
              { label: "Zonas", value: sala.status === "ready" ? sala.data.areas.length : "—", loading: sala.status === "loading", hint: location?.name ?? "Sin local" },
            ] : []),
            ...(seesTeam ? [{ label: "Equipo activo", value: members.status === "error" ? "—" : activeMembers, loading: members.status === "loading", hint: <Link href="/panel/equipo" className="inline-flex min-h-11 items-center underline underline-offset-4 sm:min-h-0">Ver el equipo</Link> }] : []),
          ]} />
        ) : null}

        {sala.status === "error" ? <LiveError title="No se han podido cargar las mesas" error={sala.error} /> : null}
        {members.status === "error" ? <LiveError title="No se ha podido cargar el equipo" error={members.error} /> : null}

        {(role === "kitchen" || role === "bar") && hasModule(restaurant, "floor") && hasModule(restaurant, "kitchen") ? (
          <EmptyState
            icon={role === "kitchen" ? <ChefHatIcon /> : <WineIcon />}
            title={role === "kitchen" ? "Tu estación de cocina" : "Tu estación de barra"}
            description="Abre tu estación para preparar los pedidos con sus tiempos y pases."
            action={<Button asChild size="lg"><Link href={role === "kitchen" ? "/panel/cocina" : "/panel/barra"}>Abrir estación</Link></Button>}
          />
        ) : null}

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {seesSala ? (
            <Card className="superficie rounded-[12px] shadow-soft ring-0 sm:rounded-[14px]">
              <CardHeader>
                <CardTitle className="font-semibold">Necesita atención</CardTitle>
                <CardDescription>Las mesas que conviene revisar antes del servicio.</CardDescription>
              </CardHeader>
              <CardContent>
                {sala.status === "loading" ? (
                  <LoadingBlock label="Cargando avisos…" />
                ) : avisos.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircleIcon aria-hidden weight="fill" className="size-4 text-success" />
                    Todo en orden en el plano.
                  </p>
                ) : (
                  <ItemGroup className="divide-y">
                    {avisos.map((a) => (
                      <Item key={a.id} size="sm" className="rounded-none px-0">
                        <ItemMedia>
                          <span aria-hidden className={a.tone === "warning" ? "size-2 rounded-full bg-warning" : "size-2 rounded-full bg-muted-foreground"} />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>{a.title}</ItemTitle>
                          <ItemDescription>{a.detail}</ItemDescription>
                        </ItemContent>
                        {a.tone === "warning" ? <Tag tone="aviso">Revisar</Tag> : null}
                      </Item>
                    ))}
                  </ItemGroup>
                )}
              </CardContent>
            </Card>
          ) : null}

          <div className="flex flex-col gap-6">
            {seesActivity ? (
              <Card className="superficie rounded-[12px] shadow-soft ring-0 sm:rounded-[14px]">
                <CardHeader>
                  <CardTitle className="font-semibold">Actividad reciente</CardTitle>
                  <CardAction>
                    <Button asChild variant="link" size="sm" className="h-auto px-0">
                      <Link href="/panel/actividad">Ver todo</Link>
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  {activity.status === "loading" ? (
                    <LoadingBlock label="Cargando la actividad…">
                      <div className="flex flex-col gap-3">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="h-4 w-1/2" />
                      </div>
                    </LoadingBlock>
                  ) : activity.status === "error" ? (
                    <LiveError title="No se ha podido cargar la actividad" error={activity.error} />
                  ) : activity.data.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Aún no hay actividad.</p>
                  ) : (
                    <ActivityTimeline entries={activity.data} now={now} />
                  )}
                </CardContent>
              </Card>
            ) : null}

            <Card className="superficie rounded-[12px] shadow-soft ring-0 sm:rounded-[14px]">
              <CardHeader>
                <CardTitle className="font-semibold">{location ? location.name : "Sin locales"}</CardTitle>
                {location ? <CardDescription>Tu local</CardDescription> : null}
              </CardHeader>
              <CardContent>
                {location ? (
                  <ul className="flex flex-col gap-3 text-sm">
                    <li className="flex gap-3">
                      <MapPinIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <span>
                        {location.address || <span className="text-muted-foreground">Sin dirección</span>}
                        {location.city ? <span className="block text-muted-foreground">{location.city}</span> : null}
                      </span>
                    </li>
                    <li className="flex gap-3">
                      <PhoneIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      {location.phone ? (
                        <a href={`tel:${location.phone.replace(/\s+/g, "")}`} className="cifra rounded text-foreground hover:text-primary">
                          {location.phone}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">Sin teléfono</span>
                      )}
                    </li>
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Este restaurante aún no tiene ningún local.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </>
  )
}
