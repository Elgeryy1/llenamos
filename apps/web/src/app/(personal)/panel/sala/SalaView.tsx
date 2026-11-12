"use client"

import { can, hasModule, type ReservationWithId } from "@llenamos/core"
import { CaretDownIcon, MapTrifoldIcon, StorefrontIcon, UsersIcon } from "@phosphor-icons/react"
import { AnimatePresence } from "motion/react"
import { useMemo, useState, type ReactNode } from "react"
import { DataTable, DataTableColumnHeader, dataTableColumns } from "@/components/common/data-table"
import { EmptyState } from "@/components/common/empty-state"
import { LiveIndicator, LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { SegmentedControl } from "@/components/common/segmented-control"
import { Tag } from "@/components/common/tag"
import { LiveError } from "@/components/panel/LiveError"
import { usePanel } from "@/components/panel/PanelContext"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { RequireModule } from "@/components/panel/RequireModule"
import { ReservationStatusDot } from "@/components/reservas/Estado"
import { GuestAvatar, GuestBadges } from "@/components/reservas/Huesped"
import { ReservationDetail } from "@/components/reservas/ReservationDetail"
import { FichaMesa } from "@/components/sala/FichaMesa"
import { SalaServicio } from "@/components/sala/SalaServicio"
import { ESTADO_MESA, Plano, PlanoLeyenda, PlanoLeyendaDirecto } from "@/components/sala/Plano"
import { planoLiveMap } from "@/components/sala/plano-live"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/cn"
import { useSala } from "@/lib/data/hooks"
import { useCustomers, useDayReservations, useReservationSettings, type CustomerDoc } from "@/lib/data/reservas"
import { localDate } from "@/lib/reservas/dia"
import { formatMinutes, tableLabel, visibleStatus } from "@/lib/reservas/estados"
import { timeOf } from "@/lib/reservas/formato"
import { useNow } from "@/lib/reservas/hooks"
import { arrivals, countStates, liveTables, type TableLiveState } from "@/lib/reservas/sala"
import type { TableDoc } from "@/lib/data/parse"
import { plural } from "@/lib/format"
import { overlappingTables, planByArea, tableStats, type AreaPlan } from "@/lib/sala/plano"

export function SalaView() {
  const { restaurant, location } = usePanel()
  return (
    <RequirePermission permission="sala.ver" what="la sala">
      <RequireModule module="floor">
        {location ? <SalaServicio key={`${restaurant.id}/${location.id}`} scope={{ restaurantId: restaurant.id, locationId: location.id }} /> : <Sala />}
      </RequireModule>
    </RequirePermission>
  )
}

const SIN_ZONA = "sin-zona"
const planKey = (p: AreaPlan) => p.area?.id ?? SIN_ZONA

function Sala() {
  const { restaurant, location, role } = usePanel()
  const sala = useSala(restaurant.id, location?.id ?? null)
  const [zone, setZone] = useState<string | null>(null)

  // Fase 1: con el módulo de reservas, cada mesa enseña su reserva de ahora o la siguiente.
  const withReservations = hasModule(restaurant, "reservations") && can(role, "reservas.ver")
  const tz = restaurant.timezone
  const now = useNow()
  const today = localDate(now, tz)
  const settings = useReservationSettings(restaurant.id, location?.id ?? null, tz, withReservations)
  const reservations = useDayReservations(
    restaurant.id,
    withReservations ? (location?.id ?? null) : null,
    today,
    settings.status === "ready" ? settings.data.config : null,
  )
  const customers = useCustomers(restaurant.id, withReservations && can(role, "clientes.ver"))
  const customerById = useMemo(() => new Map((customers.status === "ready" ? customers.data : []).map((c) => [c.id, c] as const)), [customers])
  const [openId, setOpenId] = useState<string | null>(null)
  const [tableId, setTableId] = useState<string | null>(null)
  const todays = useMemo(() => (reservations.status === "ready" ? reservations.data : []), [reservations])
  const tablesReady = sala.status === "ready" ? sala.data.tables : null
  const liveByTable = useMemo(
    () => (reservations.status === "ready" && tablesReady ? liveTables(tablesReady, todays, now) : null),
    [reservations.status, tablesReady, todays, now],
  )
  const live = useMemo(() => (liveByTable ? planoLiveMap(liveByTable, tz) : undefined), [liveByTable, tz])

  const plans = useMemo(() => (sala.status === "ready" ? planByArea(sala.data.areas, sala.data.tables) : []), [sala])
  const names = useMemo(
    () => new Map(sala.status === "ready" ? sala.data.tables.map((t) => [t.id, t.name] as const) : []),
    [sala],
  )
  const overlaps = useMemo(() => (sala.status === "ready" ? overlappingTables(sala.data.tables) : []), [sala])
  const counts = liveByTable ? countStates(liveByTable) : null

  const header = (actions?: ReactNode) => (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <p className="mb-1.5 flex items-center gap-3 text-sm text-muted-foreground">
          <span>
            <span className="text-soft-foreground">Sala en directo</span>
            {location ? <> · {location.name}</> : null}
          </span>
          {sala.status === "ready" && location ? <LiveIndicator time={timeOf(now, tz)} /> : null}
        </p>
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-balance sm:text-[32px]">{counts ? salaTitle(counts) : "Sala"}</h1>
      </div>
      {actions}
    </header>
  )

  if (!location) {
    return (
      <>
        {header()}
        <EmptyState
          icon={<StorefrontIcon />}
          title="Este restaurante aún no tiene locales"
          description="Cuando haya un local con sus zonas y mesas, el plano aparecerá aquí."
        />
      </>
    )
  }

  if (sala.status === "loading") {
    return (
      <>
        {header()}
        <LoadingBlock label="Cargando el plano…" className="flex flex-col gap-4">
          <Skeleton className="h-20 w-full rounded-[14px]" />
          <Skeleton className="aspect-[16/10] min-h-56 w-full rounded-[14px]" />
        </LoadingBlock>
      </>
    )
  }

  if (sala.status === "error") {
    return (
      <>
        {header()}
        <LiveError title="No se ha podido cargar el plano" error={sala.error} />
      </>
    )
  }

  if (plans.length === 0) {
    return (
      <>
        {header()}
        <EmptyState
          icon={<MapTrifoldIcon />}
          title={`${location.name} aún no tiene zonas ni mesas`}
          description="El editor del plano llega en la fase 1. Mientras tanto, las mesas se cargan con los datos del restaurante."
        />
      </>
    )
  }

  const total = tableStats(sala.data.tables)
  const current = plans.find((p) => planKey(p) === zone) ?? plans[0]!
  const label = current.area?.name ?? "Mesas sin zona"
  const seatedCovers = todays.filter((r) => r.status === "seated").reduce((n, r) => n + r.partySize, 0)
  const selectedTable = tableId ? (sala.data.tables.find((t) => t.id === tableId) ?? null) : null
  const selectedLive = tableId ? (liveByTable?.get(tableId) ?? null) : null
  const zoneCounts = (p: AreaPlan) => p.tables.filter((t) => {
    const s = liveByTable?.get(t.id)?.state
    return s === "seated" || s === "overtime"
  }).length

  return (
    <>
      {header(
        plans.length > 1 ? (
          <SegmentedControl
            label="Zona"
            value={planKey(current)}
            onValueChange={(z) => {
              setZone(z)
              setTableId(null)
            }}
            options={plans.map((p) => ({ value: planKey(p), label: live ? `${p.area?.name ?? "Sin zona"} · ${zoneCounts(p)}/${p.stats.enabled}` : (p.area?.name ?? "Sin zona") }))}
          />
        ) : undefined,
      )}

      {counts ? <Pulso counts={counts} seated={seatedCovers} seats={total.seats} /> : (
        <dl className="mb-5 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <div className="flex items-baseline gap-1.5">
            <dd className="cifra text-base">
              {total.enabled}
              <span className="text-muted-foreground">/{total.tables}</span>
            </dd>
            <dt className="text-muted-foreground">mesas activas</dt>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dd className="cifra text-base">{total.seats}</dd>
            <dt className="text-muted-foreground">plazas</dt>
          </div>
        </dl>
      )}

      {overlaps.length > 0 ? (
        <Notice tone="warning" title="Hay mesas que se pisan en el plano" className="mb-4">
          {overlaps.map(([a, b]) => `${names.get(a) ?? a} y ${names.get(b) ?? b}`).join(", ")}. Revisa sus posiciones.
        </Notice>
      ) : null}

      {withReservations && (settings.status === "error" || reservations.status === "error") ? (
        <div className="mb-4">
          <LiveError
            title="No se han podido cargar las reservas de hoy"
            error={settings.status === "error" ? settings.error : reservations.status === "error" ? reservations.error : null}
          />
        </div>
      ) : null}

      <div className={live ? "grid gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]" : "grid gap-6"}>
        <section aria-label={`Plano de la zona ${label}`} className="flex min-w-0 flex-col gap-3">
          {current.area === null ? <Notice tone="warning">Estas mesas apuntan a una zona que no existe.</Notice> : null}
          {current.tables.length === 0 ? (
            <EmptyState title="Esta zona aún no tiene mesas" />
          ) : (
            <div className="superficie flex flex-col gap-3 p-3">
              <Plano
                label={label}
                tables={current.tables}
                names={names}
                live={live}
                selectedId={tableId}
                onSelect={(id) => setTableId((prev) => (prev === id ? null : id))}
              />
              <div className="flex flex-wrap items-center justify-between gap-3 px-1 pb-0.5">
                {live ? <PlanoLeyendaDirecto /> : <PlanoLeyenda />}
                <p className="text-xs text-muted-foreground">
                  {plural(current.stats.enabled, "mesa activa", "mesas activas")} · {plural(current.stats.seats, "plaza", "plazas")}
                  {live ? " · pulsa una mesa para ver su ficha" : null}
                </p>
              </div>
            </div>
          )}

          <Collapsible className="superficie overflow-hidden">
            <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium hover:bg-surface-raised">
              <span>
                Mesas de {label} <span className="font-normal text-muted-foreground">· {plural(current.stats.enabled, "activa", "activas")}</span>
              </span>
              <CaretDownIcon aria-hidden className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t p-3">
              <MesasTable tables={current.tables} names={names} label={label} />
            </CollapsibleContent>
          </Collapsible>
        </section>

        {live ? (
          <aside aria-label="Mesa elegida y llegadas" className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-[calc(var(--header-height)+1.5rem)] xl:self-start">
            <AnimatePresence mode="wait" initial={false}>
              {selectedTable && selectedLive ? (
                <FichaMesa
                  key={selectedTable.id}
                  table={selectedTable}
                  live={selectedLive}
                  names={names}
                  tz={tz}
                  now={now}
                  customer={selectedLive.current ? (customerById.get(selectedLive.current.customerId) ?? null) : null}
                  onOpenReservation={setOpenId}
                  onClose={() => setTableId(null)}
                />
              ) : null}
            </AnimatePresence>
            <Arrivals list={arrivals(todays, now)} now={now} tz={tz} names={names} customers={customerById} onOpen={setOpenId} compact={selectedTable !== null} />
          </aside>
        ) : null}
      </div>

      {settings.status === "ready" && live ? (
        <ReservationDetail
          reservation={todays.find((r) => r.id === openId) ?? null}
          open={openId !== null}
          onOpenChange={(o) => !o && setOpenId(null)}
          now={now}
          config={settings.data.config}
          tables={sala.data.tables}
          tableNames={names}
        />
      ) : null}
    </>
  )
}

/** «9 mesas ocupadas, 3 llegan pronto». */
function salaTitle(c: ReturnType<typeof countStates>): string {
  const seated = c.seated + c.overtime
  const parts = [seated > 0 ? plural(seated, "mesa ocupada", "mesas ocupadas") : "Ninguna mesa ocupada"]
  if (c.late > 0) parts.push(`${c.late} ${c.late === 1 ? "va" : "van"} tarde`)
  if (c.soon > 0) parts.push(`${c.soon} ${c.soon === 1 ? "llega" : "llegan"} pronto`)
  return parts.join(", ")
}

/** El pulso de la sala en una banda: plazas ocupadas y cuántas mesas hay en cada estado. */
function Pulso({ counts, seated, seats }: { counts: Record<TableLiveState, number>; seated: number; seats: number }) {
  const pct = seats > 0 ? Math.min(100, Math.round((seated / seats) * 100)) : 0
  const items: TableLiveState[] = ["seated", "overtime", "late", "soon", "reserved", "free"]
  return (
    <section aria-label="Estado de la sala" className="superficie mb-6 grid gap-0 overflow-hidden md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
      <div className="flex flex-col gap-2.5 p-4 md:border-r">
        <p className="flex items-baseline justify-between gap-2 text-sm text-muted-foreground">
          Ocupación
          <span className="text-xs">
            <span className="cifra text-soft-foreground">{seated}</span> de <span className="cifra">{seats}</span> plazas
          </span>
        </p>
        <p className="cifra text-4xl leading-none font-semibold tracking-tight">
          {pct}
          <span className="text-xl text-muted-foreground"> %</span>
        </p>
        <Progress value={pct} aria-label="Plazas ocupadas" className="h-1.5 bg-surface-sunken [&>[data-slot=progress-indicator]]:bg-success" />
      </div>
      <ul className="grid grid-cols-3 border-t sm:grid-cols-6 md:border-t-0">
        {items.map((state) => {
          const s = ESTADO_MESA[state]
          const I = s.icon
          const n = counts[state]
          return (
            <li key={state} className={cn("flex flex-col justify-center gap-1.5 border-r border-b px-3 py-3 last:border-r-0 max-sm:[&:nth-child(3n)]:border-r-0 sm:border-b-0 sm:px-4", n === 0 && "opacity-55")}>
              <span className={cn("flex items-center gap-1.5 text-[11px] font-medium whitespace-nowrap sm:text-xs", s.text)}>
                <I aria-hidden weight="bold" className="size-3.5" />
                {s.label}
              </span>
              <span className="cifra text-2xl leading-none font-medium">{n}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Próximas llegadas de hoy, en su orden: hora grande, cliente con etiquetas, mesa. */
function Arrivals({
  list,
  now,
  tz,
  names,
  customers,
  onOpen,
  compact,
}: {
  list: ReservationWithId[]
  now: number
  tz: string
  names: ReadonlyMap<string, string>
  customers: ReadonlyMap<string, CustomerDoc>
  onOpen: (id: string) => void
  compact: boolean
}) {
  return (
    <section aria-labelledby="llegadas-titulo" className="superficie flex flex-col overflow-hidden">
      <header className="flex items-baseline justify-between gap-3 border-b px-4 py-3">
        <h2 id="llegadas-titulo" className="text-base font-semibold">
          Llegadas
        </h2>
        <span className="text-xs text-muted-foreground">próximas tres horas</span>
      </header>
      {list.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">Nadie más por llegar en las próximas horas.</p>
      ) : (
        <ScrollArea className={compact ? "max-h-72" : "max-h-[34rem]"}>
          <ul className="flex flex-col divide-y">
            {list.map((r) => {
              const late = visibleStatus(r, now).tone === "late"
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(r.id)}
                    aria-label={`Abrir la reserva de ${r.guestName} a las ${timeOf(r.startAt, tz)}`}
                    className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 ease-(--ease-llenamos) hover:bg-surface-raised"
                  >
                    <span className={cn("cifra w-12 shrink-0 pt-1.5 text-[17px] leading-none font-medium", late && "text-warning")}>{timeOf(r.startAt, tz)}</span>
                    <GuestAvatar name={r.guestName} size="sm" ring={late ? "late" : "none"} className="mt-0.5" />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate text-sm font-medium">{r.guestName}</span>
                      <span className="block min-w-0 overflow-hidden">
                        <ReservationStatusDot reservation={r} now={now} />
                      </span>
                      <GuestBadges reservation={r} customer={customers.get(r.customerId)} max={2} />
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
                      {r.tableIds.length > 0 ? (
                        <span className="cifra inline-flex h-6 items-center rounded-md border bg-surface-sunken/60 px-1.5 text-xs font-medium">{tableLabel(r.tableIds, names)}</span>
                      ) : (
                        <Tag tone="aviso">Sin mesa</Tag>
                      )}
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <UsersIcon aria-hidden className="size-3.5" />
                        <span className="cifra">{r.partySize}</span>
                      </span>
                      {late ? <span className="cifra text-[11px] text-warning">+{formatMinutes(Math.floor((now - r.startAt) / 60_000))}</span> : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      )}
    </section>
  )
}

const col = dataTableColumns<TableDoc>()

function MesasTable({ tables, names, label }: { tables: TableDoc[]; names: ReadonlyMap<string, string>; label: string }) {
  const columns = useMemo(
    () => [
      col.accessor("name", {
        header: ({ column }) => <DataTableColumnHeader column={column} title="Mesa" />,
        cell: (c) => <span className="cifra font-medium">{c.getValue()}</span>,
        sortFn: (a, b) => a.original.name.localeCompare(b.original.name, "es", { numeric: true }),
      }),
      col.accessor("seats", {
        header: ({ column }) => <DataTableColumnHeader column={column} title="Plazas" />,
        cell: (c) => <span className="cifra">{c.getValue()}</span>,
      }),
      col.accessor("joinableWith", {
        header: "Se une con",
        enableSorting: false,
        cell: (c) => {
          const joined = c.getValue().map((id) => names.get(id)).filter(Boolean)
          return joined.length ? <span className="cifra text-soft-foreground">{joined.join(", ")}</span> : <span className="text-muted-foreground">—</span>
        },
      }),
      col.accessor("enabled", {
        header: "Estado",
        enableSorting: false,
        cell: (c) => (c.getValue() ? <Tag>Activa</Tag> : <Tag tone="aviso">Deshabilitada</Tag>),
      }),
    ],
    [names],
  )
  return <DataTable caption={`Mesas de ${label}`} columns={columns} data={tables} getRowId={(t) => t.id} pageSize={50} empty="Sin mesas." />
}
