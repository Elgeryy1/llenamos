"use client"

import { can, hasModule, sessionIsOpen } from "@llenamos/core"
import Link from "next/link"
import { useState } from "react"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { SummaryStrip } from "@/components/common/summary-strip"
import { SegmentedControl } from "@/components/common/segmented-control"
import { AbrirMesa } from "@/components/comandero/GestionMesa"
import { EnlacesServicio, EstadoLectura } from "@/components/comandero/Servicio"
import { usePanel } from "@/components/panel/PanelContext"
import { TareasSala } from "@/components/tareas/TareasSala"
import { Button } from "@/components/ui/button"
import { useMesas, useTareas, useServicio, type Alcance } from "@/lib/comandero/datos"
import { estadoServicio } from "@/lib/comandero/servicio"
import { euros } from "@/lib/comandero/modelo"
import { useSala } from "@/lib/data/hooks"
import { useDayReservations, useReservationSettings } from "@/lib/data/reservas"
import { localDate } from "@/lib/reservas/dia"
import { liveTables } from "@/lib/reservas/sala"
import { planByArea } from "@/lib/sala/plano"
import { useNow } from "@/lib/reservas/hooks"
import { timeOf } from "@/lib/reservas/formato"
import { Plano, PlanoLeyendaDirecto, type PlanoLiveTable } from "./Plano"
import { planoLiveMap } from "./plano-live"

export function SalaServicio({ scope }: { scope: Alcance }) {
  const { location, restaurant, role } = usePanel()
  const sala = useSala(scope.restaurantId, scope.locationId)
  const sessions = useMesas(scope)
  const tasks = useTareas(scope)
  const lines = useServicio(scope)
  const service = (session: typeof selected, id: string) => estadoServicio(session, id, tasks.status === "ready" ? tasks.data : [], lines.status === "ready" ? lines.data : [], now)
  const [zone, setZone] = useState("")
  const [tableId, setTableId] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const now = useNow()
  const withReservations =
    hasModule(restaurant, "reservations") && can(role, "reservas.ver")
  const settings = useReservationSettings(
    scope.restaurantId,
    scope.locationId,
    restaurant.timezone,
    withReservations,
  )
  const reservations = useDayReservations(
    scope.restaurantId,
    withReservations ? scope.locationId : null,
    localDate(now, restaurant.timezone),
    settings.status === "ready" ? settings.data.config : null,
  )
  const active =
    sessions.status === "ready"
      ? sessions.data.filter((s) => sessionIsOpen(s.status))
      : []
  const selected = active.find((s) => tableId && s.tableIds.includes(tableId))
  const chosenTable =
    sala.status === "ready"
      ? sala.data.tables.find((t) => t.id === tableId)
      : null
  return (
    <div className="space-y-5">
      <PageHeading
        title={
          sessions.status === "ready"
            ? `${active.length} grupos en la sala`
            : "Sala en directo"
        }
        eyebrow={`${location?.name} · En directo · ${timeOf(now, restaurant.timezone)}`}
        description="Toca una mesa para abrirla, sentar una reserva o continuar el pedido."
      />
      <EnlacesServicio />
      {warning ? <Notice tone="warning">{warning}</Notice> : null}
      <SummaryStrip
        label="Pulso de sala"
        items={[
          {
            label: "Grupos abiertos",
            value: sessions.status === "ready" ? active.length : "…",
            loading: sessions.status === "loading",
          },
          {
            label: "Personas",
            value:
              sessions.status === "ready"
                ? active.reduce((n, s) => n + s.guests, 0)
                : "…",
            loading: sessions.status === "loading",
          },
          {
            label: "Piden la cuenta",
            value:
              sessions.status === "ready"
                ? active.filter((s) => s.status === "bill_requested").length
                : "…",
            loading: sessions.status === "loading",
          },
        ]}
      />
      <EstadoLectura live={sessions} label="las sesiones de sala">
        {() => null}
      </EstadoLectura>
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <section className="min-w-0 space-y-4">
          <EstadoLectura live={sala} label="el plano">
            {(data) => {
              const plans = planByArea(data.areas, data.tables)
              const current = plans.find((p) => p.area?.id === zone) ?? plans[0]
              const names = new Map(data.tables.map((t) => [t.id, t.name]))
              const represented = new Set(
                sessions.status === "ready"
                  ? sessions.data
                      .filter(
                        (s) =>
                          sessionIsOpen(s.status) ||
                          (s.status === "merged" &&
                            active.some((a) => a.id === s.mergedInto)),
                      )
                      .map((s) => s.reservationId)
                  : [],
              )
              const reservationLive =
                reservations.status === "ready"
                  ? planoLiveMap(
                      liveTables(
                        data.tables,
                        reservations.data.filter((r) => !represented.has(r.id)),
                        now,
                      ),
                      restaurant.timezone,
                    )
                  : null
              const live =
                sessions.status === "ready"
                  ? new Map<string, PlanoLiveTable>(
                      data.tables.map((t) => {
                        const session = active.find((s) =>
                          s.tableIds.includes(t.id),
                        )
                        if (!session && reservationLive?.has(t.id))
                          return [
                            t.id,
                            {
                              ...reservationLive.get(t.id)!,
                              clickable: t.enabled,
                            },
                          ]
                        return [
                          t.id,
                          {
                            serviceLabel: service(session, t.id).primary,
                            state: !t.enabled
                              ? "disabled"
                              : session
                                ? "seated"
                                : "free",
                            clickable: t.enabled,
                            progress: 0,
                            line: session
                              ? `${session.label} · ${session.guests} personas`
                              : "Sin sesión abierta",
                            guest: session?.guestName ?? undefined,
                            detail: session ? `${service(session, t.id).minutes}′` : undefined,
                            party: session?.guests,
                          },
                        ]
                      }),
                    )
                  : (reservationLive ?? undefined)
              return (
                <>
                  {plans.length > 1 ? (
                    <SegmentedControl
                      label="Zona"
                      value={current?.area?.id ?? "sin-zona"}
                      options={plans.map((p) => ({
                        value: p.area?.id ?? "sin-zona",
                        label: p.area?.name ?? "Sin zona",
                      }))}
                      onValueChange={(id) => {
                        setZone(id)
                        setTableId(null)
                      }}
                    />
                  ) : null}
                  {current ? (
                    <div className="superficie space-y-3 p-3">
                      <Plano
                        label={current.area?.name ?? "Sala"}
                        tables={current.tables}
                        names={names}
                        live={live}
                        selectedId={tableId}
                        onSelect={setTableId}
                      />
                      <PlanoLeyendaDirecto />
                      <p className="text-xs text-muted-foreground">Prioridad: llamada, listo para servir, pendiente de aprobación, cuenta pedida y preparando. La ficha muestra los estados que coinciden y los minutos sentados.</p>
                    </div>
                  ) : (
                    <Notice>No hay mesas en este local.</Notice>
                  )}
                </>
              )
            }}
          </EstadoLectura>
        </section>
        <aside className="min-w-0 space-y-4 xl:sticky xl:top-20">
          {selected ? (
            <section className="superficie space-y-3 p-4">
              <h2 className="text-lg font-semibold">{selected.label}</h2>
              <p>
                {selected.guests} personas ·{" "}
                {selected.waiterName ?? "Sin responsable"}
              </p>
              <p className="cifra text-xl">{euros(selected.totalCents)}</p>
              <p className="text-xs text-muted-foreground">
                Consumo registrado. No indica cobro.
              </p>
              <p className="cifra">{service(selected, tableId!).minutes} min sentados</p>
              {service(selected, tableId!).labels.map(label => <Notice key={label} tone="warning">{label}</Notice>)}
              <Button className="h-12 w-full" asChild>
                <Link
                  href={`/panel/comandero?s=${encodeURIComponent(selected.id)}`}
                >
                  Pedir y gestionar mesa
                </Link>
              </Button>
            </section>
          ) : chosenTable?.enabled ? (
            <section className="superficie space-y-4 p-4">
              <h2 className="text-lg font-semibold">
                Abrir {chosenTable.name}
              </h2>
              {sessions.status !== "ready" ? (
                <Notice tone="warning">
                  No se puede comprobar si está ocupada. El servidor comprobará
                  la apertura y puede rechazarla.
                </Notice>
              ) : null}
              <AbrirMesa
                key={chosenTable.id}
                scope={scope}
                initialTableId={chosenTable.id}
                onOpened={(_, note) => setWarning(note)}
              />
            </section>
          ) : (
            <Notice>
              Toca una mesa para ver el servicio. También puedes abrirla desde
              el comandero.
            </Notice>
          )}
        </aside>
      </div>
      <EstadoLectura live={tasks} label="los avisos de las mesas">{() => null}</EstadoLectura>
      <EstadoLectura live={lines} label="el estado de los platos">{() => null}</EstadoLectura>
      <TareasSala scope={scope} />
    </div>
  )
}
