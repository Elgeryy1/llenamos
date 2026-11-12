"use client"

import { can, instanteDeHoraLocal, sumarDias, type ReservationWithId } from "@llenamos/core"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarBlankIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ChartBarHorizontalIcon,
  ClockIcon,
  ListBulletsIcon,
  MagnifyingGlassIcon,
  MapTrifoldIcon,
  PlusIcon,
  UserIcon,
} from "@phosphor-icons/react"
import { useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { DatePicker } from "@/components/common/date-picker"
import { EmptyState } from "@/components/common/empty-state"
import { LiveIndicator, LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { SegmentedControl, type SegmentedOption } from "@/components/common/segmented-control"
import { Tag } from "@/components/common/tag"
import { useRegisterCommands, type PanelCommandGroup } from "@/components/panel/command/commands"
import { overlayOpen, useHotkeys } from "@/components/panel/command/hotkeys"
import { Keys } from "@/components/panel/command/Keys"
import { LiveError } from "@/components/panel/LiveError"
import { usePanel } from "@/components/panel/PanelContext"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { ShiftList } from "@/components/reservas/ListaDia"
import { NewReservationSheet } from "@/components/reservas/NewReservationSheet"
import { RequireReservations } from "@/components/reservas/RequireReservations"
import { ReservationDetail } from "@/components/reservas/ReservationDetail"
import { useReservationActions } from "@/components/reservas/ReservationActions"
import { ResumenTurno, type RitmoBar } from "@/components/reservas/ResumenTurno"
import { Timeline } from "@/components/reservas/Timeline"
import { BarraReserva, PlanoReservas, useIsSplit, usePartida } from "@/components/reservas/VistaPartida"
import { planoLiveMap } from "@/components/sala/plano-live"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/cn"
import { useCustomers, type CustomerDoc } from "@/lib/data/reservas"
import { coversBySlot, currentShiftIndex, groupByShift, localDate, summarize } from "@/lib/reservas/dia"
import { countByFilter, matchesFilter, matchesSearch, STATUS_FILTER_LABEL, STATUS_FILTERS, tableLabel, visibleStatus, type StatusFilter } from "@/lib/reservas/estados"
import { dateToFecha, euros, fechaToDate, longDate, relativeDay, timeOf } from "@/lib/reservas/formato"
import { useDayData, useNow, type DayData } from "@/lib/reservas/hooks"
import { arrivals, liveTables } from "@/lib/reservas/sala"
import { tableStats } from "@/lib/sala/plano"
import { useStoredValue } from "@/lib/stored"

export function ReservasView() {
  return (
    <RequirePermission permission="reservas.ver" what="las reservas">
      <RequireReservations>
        <Reservas />
      </RequireReservations>
    </RequirePermission>
  )
}

const ALL_DAY = "all"

/**
 * Vistas de Reservas. «lista» es la lista de B; a partir de la tableta apaisada va partida
 * con el plano al lado (propuesta C). «tiempo» es la línea de tiempo por mesa (propuesta A).
 * «plano» solo existe en pantallas estrechas, donde no caben lista y plano a la vez.
 */
type View = "lista" | "tiempo" | "plano"

/** Título de la página con su línea de encima y la acción principal a la derecha. */
function ServiceTitle({ eyebrow, title, children, action }: { eyebrow: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 sm:mb-6">
      <div className="min-w-0">
        <p className="mb-1.5 text-[13px] text-muted-foreground sm:text-sm">{eyebrow}</p>
        <h1 className="text-[24px] leading-tight font-semibold tracking-tight text-balance sm:text-[32px]">{title}</h1>
        {children ? <div className="mt-2.5 flex flex-wrap items-center gap-2 sm:mt-3">{children}</div> : null}
      </div>
      {action ? <div className="flex items-center gap-2 max-sm:w-full max-sm:[&>button]:flex-1">{action}</div> : null}
    </header>
  )
}

function Reservas() {
  const { restaurant, location, role } = usePanel()
  const now = useNow()
  const tz = restaurant.timezone
  const today = localDate(now, tz)
  const [date, setDate] = useState<string | null>(null)
  const day = date ?? today
  const data = useDayData(restaurant.id, location?.id ?? null, day, tz)
  const customers = useCustomers(restaurant.id, can(role, "clientes.ver"))
  const canManage = can(role, "reservas.gestionar")
  const [creating, setCreating] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const eyebrow = (
    <>
      <span className="text-soft-foreground">{capitalize(relativeDay(day, today) === "hoy" ? `hoy, ${longDate(day)}` : longDate(day))}</span>
      {location ? <> · {location.name}</> : null}
    </>
  )
  const action = canManage ? (
    <Button size="lg" className="shadow-soft" onClick={() => setCreating(true)} disabled={data.status !== "ready"}>
      <PlusIcon aria-hidden weight="bold" /> Nueva reserva
      <Keys keys={["n"]} className="hidden opacity-80 lg:inline-flex [&_kbd]:border-primary-foreground/25 [&_kbd]:bg-primary-foreground/10 [&_kbd]:text-primary-foreground [&_kbd]:shadow-none" />
    </Button>
  ) : undefined

  // En el móvil la fecha va corta y sin icono para que el día y el turno quepan en una línea.
  const dayNav = (
    <div className="flex items-center gap-0.5 rounded-lg border bg-surface-sunken/60 p-0.5">
      <Button variant="ghost" size="icon" className="max-sm:w-8" aria-label="Día anterior" onClick={() => setDate(sumarDias(day, -1))}>
        <CaretLeftIcon />
      </Button>
      <DatePicker value={fechaToDate(day)} onChange={(d) => setDate(dateToFecha(d))} label="Día de las reservas" className="max-sm:px-1.5" shortOnMobile />
      <Button variant="ghost" size="icon" className="max-sm:w-8" aria-label="Día siguiente" onClick={() => setDate(sumarDias(day, 1))}>
        <CaretRightIcon />
      </Button>
      {day !== today ? (
        <Button variant="ghost" size="sm" onClick={() => setDate(null)}>
          <CalendarBlankIcon aria-hidden className="max-sm:hidden" /> Hoy
        </Button>
      ) : null}
    </div>
  )

  if (data.status === "loading") {
    return (
      <>
        <ServiceTitle eyebrow={eyebrow} title="Reservas" action={action} />
        {dayNav}
        <LoadingBlock label="Cargando las reservas…" className="mt-6 flex flex-col gap-4">
          <Skeleton className="h-52 w-full rounded-[14px]" />
          <Skeleton className="h-96 w-full rounded-[14px]" />
        </LoadingBlock>
      </>
    )
  }
  if (data.status === "error") {
    return (
      <>
        <ServiceTitle eyebrow={eyebrow} title="Reservas" action={action} />
        {dayNav}
        <div className="mt-6">
          <LiveError title="No se han podido cargar las reservas" error={data.error} />
        </div>
      </>
    )
  }

  return (
    <DayContent
      data={data.data}
      customers={customers.status === "ready" ? customers.data : null}
      day={day}
      today={today}
      now={now}
      eyebrow={eyebrow}
      action={action}
      dayNav={dayNav}
      canManage={canManage}
      setDate={setDate}
      creating={creating}
      setCreating={setCreating}
      detailId={detailId}
      setDetailId={setDetailId}
      onCreated={(id, d) => {
        setCreating(false)
        if (d !== day) setDate(d)
        setDetailId(id)
      }}
    />
  )
}

function DayContent({
  data,
  customers,
  day,
  today,
  now,
  eyebrow,
  action,
  dayNav,
  canManage,
  setDate,
  creating,
  setCreating,
  detailId,
  setDetailId,
  onCreated,
}: {
  data: DayData
  customers: CustomerDoc[] | null
  day: string
  today: string
  now: number
  eyebrow: ReactNode
  action: ReactNode
  dayNav: ReactNode
  canManage: boolean
  setDate: (d: string | null) => void
  creating: boolean
  setCreating: (v: boolean) => void
  detailId: string | null
  setDetailId: (id: string | null) => void
  onCreated: (id: string, date: string) => void
}) {
  const { user } = usePanel()
  const { config } = data.settings
  const tz = config.zonaHoraria
  const isToday = day === today
  const allGroups = useMemo(() => groupByShift(data.reservations, config, day, { includeEmpty: true }), [data.reservations, config, day])
  const shiftOptions = useMemo<SegmentedOption<string>[]>(
    () => [
      ...allGroups.filter((g) => g.shift.index >= 0).map((g) => ({ value: String(g.shift.index), label: g.shift.name })),
      { value: ALL_DAY, label: "Todo el día", short: "Todo" },
    ],
    [allGroups],
  )
  const current = currentShiftIndex(config, day, now)
  const [shiftPick, setShiftPick] = useState<string | null>(null)
  const shift = shiftPick ?? (isToday && current !== null && shiftOptions.length > 2 ? String(current) : ALL_DAY)
  const [filter, setFilter] = useState<StatusFilter>("all")
  const [search, setSearch] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)
  const customerById = useMemo(() => new Map((customers ?? []).map((c) => [c.id, c] as const)), [customers])

  // Vista elegida, recordada por persona en este navegador.
  const split = useIsSplit()
  const [storedView, setView] = useStoredValue(`llenamos:reservas:vista:${user.uid}`)
  const picked: View = storedView === "tiempo" || storedView === "plano" ? storedView : "lista"
  const view: View = split && picked === "plano" ? "lista" : picked
  const viewOptions: SegmentedOption<View>[] = [
    { value: "lista", label: "Lista", icon: <ListBulletsIcon aria-hidden /> },
    ...(split ? [] : [{ value: "plano" as const, label: "Plano", icon: <MapTrifoldIcon aria-hidden /> }]),
    { value: "tiempo", label: "Tiempo", icon: <ChartBarHorizontalIcon aria-hidden /> },
  ]

  const inShift = useMemo(() => (shift === ALL_DAY ? allGroups : allGroups.filter((g) => String(g.shift.index) === shift)), [allGroups, shift])
  const shiftReservations = useMemo(() => inShift.flatMap((g) => g.reservations), [inShift])
  const summary = summarize(shiftReservations)
  const counts = countByFilter(shiftReservations.filter((r) => matchesSearch(r, search)))
  const matches = (r: ReservationWithId) => matchesFilter(r.status, filter) && matchesSearch(r, search)
  const visibleGroups = useMemo(
    () =>
      inShift
        .map((g) => ({ ...g, reservations: g.reservations.filter((r) => matchesFilter(r.status, filter) && matchesSearch(r, search)) }))
        .filter((g) => g.reservations.length > 0),
    [inShift, filter, search],
  )
  const bars = useMemo<RitmoBar[]>(
    () => inShift.filter((g) => g.shift.index >= 0).flatMap((g, gi) => coversBySlot(g, config, day).map((b, i) => ({ ...b, gapBefore: gi > 0 && i === 0 }))),
    [inShift, config, day],
  )
  const upcoming = useMemo(() => {
    const list = isToday ? arrivals(shiftReservations, now, 4) : shiftReservations.filter((r) => r.status === "pending" || r.status === "confirmed")
    return list.slice(0, 4)
  }, [shiftReservations, isToday, now])

  // Plano: hoy, en directo; otro día, cada mesa con su primera reserva del día.
  const planAt = useMemo(() => (isToday ? now : (instanteDeHoraLocal(day, 0, tz) ?? now)), [isToday, now, day, tz])
  const byTable = useMemo(() => liveTables(data.sala.tables, data.reservations, planAt), [data.sala.tables, data.reservations, planAt])
  const live = useMemo(() => planoLiveMap(byTable, tz), [byTable, tz])

  const openDetail = (r: ReservationWithId) => setDetailId(r.id)
  const partida = usePartida({
    split,
    reservations: data.reservations,
    byTable,
    onOpenDetail: openDetail,
    onReveal: (r) => {
      // Una mesa puede tener su reserva oculta por el turno, el filtro o la búsqueda.
      if (!shiftReservations.some((item) => item.id === r.id)) setShiftPick(ALL_DAY)
      if (!matches(r)) {
        setFilter("all")
        setSearch("")
      }
    },
  })
  const api = useReservationActions({ reservations: data.reservations, config, tables: data.sala.tables, tableNames: data.tableNames })

  const detail = data.reservations.find((r) => r.id === detailId) ?? null
  const shiftName = shift === ALL_DAY ? null : allGroups.find((g) => String(g.shift.index) === shift)?.shift.name.toLowerCase()
  const when = relativeDay(day, today)
  const title =
    data.reservations.length === 0
      ? `Sin reservas ${when}`
      : `${summary.covers} ${summary.covers === 1 ? "cubierto" : "cubiertos"}${shiftName ? ` en la ${shiftName}` : ""} ${when}`
  const closed = groupByShift([], config, day, { includeEmpty: true }).length === 0
  const late = shiftReservations.filter((r) => visibleStatus(r, now).tone === "late").length

  // Atajos de la pantalla (propuesta A). Las teclas sueltas no cuentan mientras se escribe o hay una ventana abierta.
  const cycleView = () => setView(view === "tiempo" ? "lista" : "tiempo")
  const outsideTimeline = () => !document.activeElement?.closest("[data-linea-tiempo]")
  useHotkeys({
    n: () => canManage && setCreating(true),
    "/": () => searchRef.current?.focus(),
    v: cycleView,
    t: () => setDate(null),
    arrowleft: () => outsideTimeline() ? setDate(sumarDias(day, -1)) : false,
    arrowright: () => outsideTimeline() ? setDate(sumarDias(day, 1)) : false,
    j: () => moveRowFocus(1),
    k: () => moveRowFocus(-1),
    escape: () => partida.clear(),
    "mod+enter": () => {
      const r = partida.selected
      if (!r || overlayOpen()) return false
      const primary = api.planFor(r, now).primary
      if (primary) void api.act(r, primary)
    },
    ...Object.fromEntries(shiftOptions.map((o, i) => [String(i + 1), () => setShiftPick(o.value)])),
  })

  const commands = useMemo<PanelCommandGroup[]>(() => {
    const actions: PanelCommandGroup = {
      id: "reservas-acciones",
      heading: "Reservas",
      commands: [
        ...(canManage ? [{ id: "nueva", label: "Nueva reserva", icon: <PlusIcon />, shortcut: ["n"], onSelect: () => setCreating(true) }] : []),
        {
          id: "vista",
          label: view === "tiempo" ? "Ver la lista" : "Ver la línea de tiempo",
          icon: view === "tiempo" ? <ListBulletsIcon /> : <ChartBarHorizontalIcon />,
          shortcut: ["v"],
          onSelect: cycleView,
        },
        { id: "buscar", label: "Buscar en el día", icon: <MagnifyingGlassIcon />, shortcut: ["/"], onSelect: () => searchRef.current?.focus() },
        { id: "hoy", label: "Ir a hoy", icon: <CalendarBlankIcon />, shortcut: ["t"], onSelect: () => setDate(null) },
        { id: "antes", label: "Día anterior", icon: <ArrowLeftIcon />, shortcut: ["arrowleft"], onSelect: () => setDate(sumarDias(day, -1)) },
        { id: "despues", label: "Día siguiente", icon: <ArrowRightIcon />, shortcut: ["arrowright"], onSelect: () => setDate(sumarDias(day, 1)) },
        { id: "bajar", label: "Bajar por la lista", icon: <ListBulletsIcon />, shortcut: ["j"], onSelect: () => moveRowFocus(1) },
        { id: "subir", label: "Subir por la lista", icon: <ListBulletsIcon />, shortcut: ["k"], onSelect: () => moveRowFocus(-1) },
        ...shiftOptions.map((o, i) => ({ id: `turno-${o.value}`, label: `Turno: ${o.label.toLowerCase()}`, icon: <ClockIcon />, shortcut: [String(i + 1)], onSelect: () => setShiftPick(o.value) })),
      ],
    }
    const list: PanelCommandGroup = {
      id: "reservas-dia",
      heading: `Reservas de ${when}`,
      commands: data.reservations.map((r) => {
        const mesa = r.tableIds.length > 0 ? tableLabel(r.tableIds, data.tableNames) : "sin mesa"
        return {
          id: r.id,
          label: r.guestName,
          hint: `${timeOf(r.startAt, tz)} · ${r.partySize} pers. · ${mesa}`,
          keywords: [r.phone, r.reference, mesa, timeOf(r.startAt, tz)],
          icon: <UserIcon />,
          onSelect: () => setDetailId(r.id),
        }
      }),
    }
    return [actions, list]
    // cycleView y los setters no cambian lo que hace cada orden más allá de `view` y `day`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, view, day, shiftOptions, when, data.reservations, data.tableNames, tz])
  useRegisterCommands("reservas", commands)

  const stacked = split && view === "lista"
  const filterBar = (
    <FilterBar filter={filter} setFilter={setFilter} counts={counts} search={search} setSearch={setSearch} searchRef={searchRef} stacked={stacked} />
  )

  const empty =
    data.reservations.length === 0 ? (
      <EmptyState
        icon={<CalendarBlankIcon size={22} />}
        title={`Aún no hay reservas ${when}`}
        description="Las de la web aparecen aquí solas en cuanto llegan. Las de teléfono se apuntan con «Nueva reserva»."
      />
    ) : visibleGroups.length === 0 ? (
      <EmptyState icon={<MagnifyingGlassIcon size={22} />} title="Nada con ese filtro" description="Prueba con otro estado, otro turno o borra la búsqueda." />
    ) : null

  const list = empty ?? (
    <div className="flex flex-col gap-8">
      {visibleGroups.map((g) => (
        <ShiftList
          key={g.shift.index}
          group={g}
          now={now}
          tz={tz}
          tableNames={data.tableNames}
          customers={customerById}
          selectedId={split ? partida.selectedId : null}
          onOpen={partida.selectRow}
        />
      ))}
    </div>
  )

  const plano = (footer?: ReactNode) => (
    <PlanoReservas
      areas={data.sala.areas}
      tables={data.sala.tables}
      names={data.tableNames}
      live={live}
      selectedTableIds={partida.selected?.tableIds ?? []}
      onSelectTable={partida.selectTable}
      footer={footer}
    />
  )

  return (
    <>
      <ServiceTitle eyebrow={eyebrow} title={title} action={action}>
        {closed ? <Tag tone="aviso">El local no abre este día según su horario</Tag> : null}
        {late > 0 ? <Tag tone="aviso">{late === 1 ? "1 reserva va tarde" : `${late} reservas van tarde`}</Tag> : null}
        {summary.pending > 0 ? <Tag tone="aviso">{summary.pending === 1 ? "1 sin confirmar" : `${summary.pending} sin confirmar`}</Tag> : null}
        {summary.withoutTable > 0 ? <Tag tone="aviso">{summary.withoutTable === 1 ? "1 sin mesa" : `${summary.withoutTable} sin mesa`}</Tag> : null}
        {summary.depositsPaidCents > 0 ? <Tag>Señales pagadas {euros(summary.depositsPaidCents)}</Tag> : null}
      </ServiceTitle>

      <div className="mb-5 flex flex-wrap items-center gap-2 sm:gap-3">
        {/* Día y turno siempre en la misma línea, también a 390 px. */}
        <div className="flex min-w-0 items-center gap-1.5 max-sm:w-full max-sm:justify-between sm:gap-3">
          {dayNav}
          {shiftOptions.length > 1 ? <SegmentedControl label="Turno" value={shift} onValueChange={setShiftPick} options={shiftOptions} /> : null}
        </div>
        <SegmentedControl label="Vista" value={view} onValueChange={setView} options={viewOptions} className="max-sm:w-full max-sm:*:flex-1" />
        <span className="hidden xl:inline-flex">
          <LiveIndicator time={timeOf(now, tz)} />
        </span>
      </div>

      {!data.settings.saved ? (
        <Notice tone="info" className="mb-6" title="Este local usa el horario por defecto">
          Comida de 13:00 a 15:30 y cena de 20:00 a 22:30, cerrado los lunes. Se cambia en Horarios.
        </Notice>
      ) : null}

      <div className="mb-6 sm:mb-8">
        <ResumenTurno
          summary={summary}
          bars={bars}
          now={now}
          upcoming={upcoming}
          upcomingTitle={isToday ? "Próximas llegadas" : "Primeras llegadas"}
          seats={isToday ? tableStats(data.sala.tables).seats : undefined}
          tz={tz}
          tableNames={data.tableNames}
          onOpen={openDetail}
        />
      </div>

      {api.error ? (
        <Notice tone="error" className="mb-4" title="No se ha podido guardar" detail={api.error.code}>
          {api.error.message}
        </Notice>
      ) : null}

      {stacked ? (
        // Vista partida: la lista a la izquierda y el plano, fijo al bajar, a la derecha.
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)] items-start gap-6">
          <div className="@container/lista flex min-w-0 flex-col">
            {filterBar}
            {list}
          </div>
          <aside aria-label="Plano y reserva elegida" className="sticky top-[calc(var(--header-height)+1rem)] min-w-0">
            {plano(
              <BarraReserva
                reservation={partida.selected}
                now={now}
                tz={tz}
                tableNames={data.tableNames}
                api={api}
                onOpenDetail={openDetail}
                onClear={partida.clear}
              />,
            )}
          </aside>
        </div>
      ) : view === "tiempo" ? (
        <>
          {filterBar}
          {data.reservations.length === 0 ? (
            empty
          ) : (
            <div data-linea-tiempo>
              <Timeline
                groups={inShift}
                config={config}
                day={day}
                now={now}
                areas={data.sala.areas}
                tables={data.sala.tables}
                tableNames={data.tableNames}
                matches={matches}
                selectedId={detailId}
                onOpen={openDetail}
              />
            </div>
          )}
        </>
      ) : view === "plano" ? (
        plano()
      ) : (
        <div className="@container/lista">
          {filterBar}
          {list}
        </div>
      )}

      <p className="mt-4 hidden items-center gap-4 text-xs text-muted-foreground lg:flex">
        <span className="flex items-center gap-1.5">
          <Keys keys={["mod", "k"]} /> buscar o ir a
        </span>
        {view === "lista" ? (
          <span className="flex items-center gap-1.5">
            <Keys keys={["j"]} />
            <Keys keys={["k"]} /> moverse por la lista
          </span>
        ) : null}
        <span className="flex items-center gap-1.5">
          <Keys keys={["v"]} /> lista o tiempo
        </span>
        <span className="flex items-center gap-1.5">
          <Keys keys={["arrowleft"]} />
          <Keys keys={["arrowright"]} /> otro día
        </span>
        <span className="flex items-center gap-1.5">
          <Keys keys={["?"]} /> todos los atajos
        </span>
      </p>

      {api.dialogs}
      <ReservationDetail
        reservation={detail}
        open={detailId !== null}
        onOpenChange={(o) => !o && setDetailId(null)}
        now={now}
        config={config}
        tables={data.sala.tables}
        tableNames={data.tableNames}
      />
      <NewReservationSheet open={creating} onOpenChange={setCreating} defaultDate={day} config={config} tables={data.sala.tables} onCreated={onCreated} />
    </>
  )
}

/** Pestañas por estado con su cifra y el buscador. Fijas arriba al bajar por la lista. */
function FilterBar({
  filter,
  setFilter,
  counts,
  search,
  setSearch,
  searchRef,
  stacked,
}: {
  filter: StatusFilter
  setFilter: (f: StatusFilter) => void
  counts: Record<StatusFilter, number>
  search: string
  setSearch: (s: string) => void
  searchRef: RefObject<HTMLInputElement | null>
  /** En la columna de la vista partida: pestañas encima del buscador. */
  stacked: boolean
}) {
  return (
    <div
      className={cn(
        "z-10 mb-4 flex flex-col gap-3 border-b bg-background/92 pt-2 pb-3 backdrop-blur-md lg:sticky lg:top-(--header-height)",
        stacked ? "-mx-1 px-1" : "-mx-4 px-4 md:-mx-6 md:px-6 lg:-mx-8 lg:flex-row lg:items-end lg:justify-between lg:px-8",
      )}
    >
      <Tabs value={filter} onValueChange={(v) => setFilter(v as StatusFilter)}>
        <div className="no-scrollbar max-w-full overflow-x-auto overflow-y-hidden">
          <TabsList variant="line" aria-label="Filtrar por estado" className="gap-4">
            {STATUS_FILTERS.map((f) => (
              <TabsTrigger key={f} value={f} className="gap-1.5 px-0 text-[15px]">
                {f === "dropped" ? "Canceladas" : STATUS_FILTER_LABEL[f]}
                <span className="cifra rounded-full bg-foreground/[0.07] px-1.5 text-[11px] leading-[18px] text-soft-foreground">{counts[f]}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>
      <InputGroup className={cn("bg-card", !stacked && "lg:w-80")}>
        <InputGroupAddon>
          <MagnifyingGlassIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          ref={searchRef}
          type="search"
          aria-label="Buscar reserva"
          placeholder="Nombre, teléfono o referencia"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSearch("")
              e.currentTarget.blur()
            }
          }}
        />
        <InputGroupAddon align="inline-end" className="hidden lg:flex">
          <Keys keys={["/"]} />
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

/** J y K: el foco baja o sube por las filas de la lista; Intro la abre (o la elige). */
function moveRowFocus(step: 1 | -1) {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-reserva-fila]")]
  if (rows.length === 0) return
  const at = rows.findIndex((el) => el === document.activeElement)
  const next = at === -1 ? (step === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step))
  rows[next]?.focus()
  rows[next]?.scrollIntoView({ block: "nearest" })
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
