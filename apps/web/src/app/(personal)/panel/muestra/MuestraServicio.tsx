"use client"

/*
 * Piezas del diseño final (B con la línea de tiempo y la paleta de A y la vista partida de
 * C) con datos de ejemplo inventados. Aquí no se lee ni se escribe nada: las acciones solo
 * enseñan un aviso.
 */
import { configuracionReservasInicial, instanteDeHoraLocal, type ReservationWithId } from "@llenamos/core"
import { MagnifyingGlassIcon } from "@phosphor-icons/react"
import { useMemo, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { SegmentedControl } from "@/components/common/segmented-control"
import { useCommandPalette } from "@/components/panel/command/commands"
import { Keys } from "@/components/panel/command/Keys"
import { ShiftList } from "@/components/reservas/ListaDia"
import { Timeline } from "@/components/reservas/Timeline"
import { BarraReserva, PlanoReservas, usePartida } from "@/components/reservas/VistaPartida"
import { Plano, type PlanoLiveTable } from "@/components/sala/Plano"
import { planoLiveMap } from "@/components/sala/plano-live"
import { Button } from "@/components/ui/button"
import type { AreaDoc, TableDoc } from "@/lib/data/parse"
import { groupByShift, localDate } from "@/lib/reservas/dia"
import { actionsFor } from "@/lib/reservas/estados"
import { liveTables } from "@/lib/reservas/sala"

const TZ = "Europe/Madrid"
const AREAS: AreaDoc[] = [
  { id: "m-sala", name: "Sala", sortOrder: 0 },
  { id: "m-terraza", name: "Terraza", sortOrder: 1 },
]
const TABLES: TableDoc[] = [
  { id: "m1", name: "S1", areaId: "m-sala", seats: 2, shape: "rect", x: 6, y: 12, w: 12, h: 20, joinableWith: [], enabled: true },
  { id: "m2", name: "S2", areaId: "m-sala", seats: 4, shape: "round", x: 26, y: 12, w: 12, h: 20, joinableWith: [], enabled: true },
  { id: "m3", name: "S3", areaId: "m-sala", seats: 6, shape: "rect", x: 46, y: 12, w: 16, h: 20, joinableWith: [], enabled: true },
  { id: "m4", name: "S4", areaId: "m-sala", seats: 4, shape: "round", x: 70, y: 12, w: 12, h: 20, joinableWith: [], enabled: true },
  { id: "m5", name: "T1", areaId: "m-terraza", seats: 4, shape: "rect", x: 10, y: 20, w: 14, h: 20, joinableWith: [], enabled: true },
]
const NAMES = new Map(TABLES.map((t) => [t.id, t.name] as const))

function ejemplo(n: number, startAt: number, changes: Partial<ReservationWithId>): ReservationWithId {
  return {
    id: `muestra-${n}`,
    guestName: "",
    phone: "+34600000000",
    email: null,
    language: "es",
    partySize: 2,
    startAt,
    durationMinutes: 90,
    status: "confirmed",
    tableIds: [],
    suggestedTableIds: [],
    suggestionReason: null,
    source: "web",
    notes: "",
    guestNotes: "",
    customerId: `muestra${n}`,
    reference: `MUE${n}AA`,
    manageTokenHash: "0".repeat(64),
    deposit: { status: "none", amountCents: 0, checkoutSessionId: null },
    history: [],
    createdBy: null,
    ...changes,
  }
}

/** Un servicio inventado alrededor de ahora: unos sentados, uno que va tarde y otros por llegar. */
function useEjemplo(now: number) {
  return useMemo(() => {
    const day = localDate(now, TZ)
    const base = now - (now % (15 * 60_000))
    const list = [
      ejemplo(1, base - 60 * 60_000, { guestName: "Familia Roca", partySize: 5, tableIds: ["m3"], status: "seated" }),
      ejemplo(2, base - 30 * 60_000, { guestName: "Clara Ibáñez", tableIds: ["m1"], status: "seated", guestNotes: "Alergia a los frutos secos" }),
      ejemplo(3, base - 15 * 60_000, { guestName: "Pau Ferrer", partySize: 4, tableIds: ["m2"], source: "phone" }),
      ejemplo(4, base + 15 * 60_000, { guestName: "Marc Serra", tableIds: ["m4"] }),
      ejemplo(5, base + 30 * 60_000, { guestName: "Núria Bosch", partySize: 3, tableIds: ["m5"], status: "pending" }),
    ]
    const config = { ...configuracionReservasInicial(TZ) }
    // Un turno que abarca el ejemplo, sea la hora que sea.
    const desde = Math.max(0, Math.floor(((base - 90 * 60_000 - (instanteDeHoraLocal(day, 0, TZ) ?? 0)) / 60_000) / 30) * 30)
    const hasta = Math.min(23 * 60 + 30, desde + 180)
    const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
    const turno = [{ nombre: "Servicio", desde: hh(desde), ultimaEntrada: hh(hasta) }]
    config.semana = { lun: turno, mar: turno, mie: turno, jue: turno, vie: turno, sab: turno, dom: turno }
    return { day, list, config }
  }, [now])
}

function Bloque({ title, origin, children }: { title: string; origin: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-soft-foreground">{title}</h3>
        <span className="cifra text-xs text-muted-foreground">{origin}</span>
      </div>
      {children}
    </section>
  )
}

export function MuestraServicio({ now }: { now: number }) {
  const { day, list, config } = useEjemplo(now)
  const palette = useCommandPalette()
  const byTable = useMemo(() => liveTables(TABLES, list, now), [list, now])
  const live = useMemo(() => planoLiveMap(byTable, TZ), [byTable])
  const groups = useMemo(() => groupByShift(list, config, day), [list, config, day])
  const partida = usePartida({ split: true, reservations: list, byTable, onOpenDetail: (r) => toast(`Aquí se abriría el detalle de ${r.guestName}.`) })
  const api = {
    act: async (r: ReservationWithId) => void toast(`Muestra: no se guarda nada (${r.guestName}).`),
    busyId: null,
    planFor: (r: ReservationWithId, at: number) => actionsFor(r, at, NAMES, { canManage: true }),
  }
  const [vista, setVista] = useState<"lista" | "tiempo">("lista")

  // Mesas redondas pequeñas: el texto en la franja central, nunca contra el borde.
  const redondas: TableDoc[] = [
    { id: "r1", name: "R1", areaId: "x", seats: 2, shape: "round", x: 4, y: 20, w: 9, h: 40, joinableWith: [], enabled: true },
    { id: "r2", name: "R2", areaId: "x", seats: 4, shape: "round", x: 20, y: 20, w: 11, h: 44, joinableWith: [], enabled: true },
    { id: "r3", name: "R3", areaId: "x", seats: 4, shape: "round", x: 40, y: 20, w: 13, h: 50, joinableWith: [], enabled: true },
    { id: "r4", name: "R4", areaId: "x", seats: 6, shape: "round", x: 62, y: 16, w: 16, h: 60, joinableWith: [], enabled: true },
  ]
  const redondasLive = new Map<string, PlanoLiveTable>([
    ["r1", { state: "late", line: "Marc Serra · 14:48", progress: 0, clickable: false, guest: "Marc Serra", detail: "14:48" }],
    ["r2", { state: "seated", line: "Pau Ferrer · 78 min", progress: 0.6, clickable: false, guest: "Pau Ferrer", detail: "78′", party: 4 }],
    ["r3", { state: "soon", line: "Clara Ibáñez · 15:05", progress: 0, clickable: false, guest: "Clara Ibáñez", detail: "15:05" }],
    ["r4", { state: "overtime", line: "Familia Roca · 132 min", progress: 1, clickable: false, guest: "Familia Roca", detail: "132′", party: 6 }],
  ])

  return (
    <div className="flex flex-col gap-8">
      <Bloque title="Capas de la sala cálida" origin="globals.css · utilidad superficie, sombras suaves">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            ["bg-surface-sunken", "Hundida", "#0f0e0a · plano, barras"],
            ["bg-background", "Fondo", "#131209"],
            ["bg-card shadow-soft", "Bloque", "#1b1914 · superficie"],
            ["bg-surface-raised shadow-soft", "Alzada", "#211e18 · fila elegida"],
            ["bg-popover shadow-float", "Flotante", "#24211b · paneles y paleta"],
          ].map(([cls, label, hint]) => (
            <div key={label} className={`flex h-24 flex-col justify-end gap-0.5 rounded-[14px] border p-3 ${cls}`}>
              <span className="text-sm font-medium">{label}</span>
              <span className="cifra text-[11px] text-muted-foreground">{hint}</span>
            </div>
          ))}
        </div>
      </Bloque>

      <Bloque title="Paleta de órdenes y atajos" origin="panel/command (propuesta A) · @shadcn/command (cmdk) · @shadcn/kbd">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={palette.open} className="h-9 gap-2 bg-card font-normal text-muted-foreground shadow-soft sm:w-60 sm:justify-start">
            <MagnifyingGlassIcon aria-hidden /> Buscar o ir a… <Keys keys={["mod", "k"]} className="ml-auto" />
          </Button>
          <Button variant="ghost" onClick={palette.help}>
            Ver los atajos <Keys keys={["?"]} />
          </Button>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Keys keys={["g", "r"]} then /> ir a reservas
          </span>
        </div>
      </Bloque>

      <Bloque title="Reservas: lista o tiempo" origin="reservas/ListaDia (B) · reservas/Timeline (A, restilada)">
        <SegmentedControl
          label="Vista de la muestra"
          value={vista}
          onValueChange={setVista}
          options={[
            { value: "lista", label: "Lista" },
            { value: "tiempo", label: "Tiempo" },
          ]}
          className="self-start"
        />
        {vista === "tiempo" ? (
          <Timeline groups={groups} config={config} day={day} now={now} areas={AREAS} tables={TABLES} tableNames={NAMES} matches={() => true} selectedId={null} onOpen={(r) => toast(`Aquí se abriría el detalle de ${r.guestName}.`)} />
        ) : (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)]">
            <div className="@container/lista flex min-w-0 flex-col gap-6">
              {groups.map((g) => (
                <ShiftList key={g.shift.index} group={g} now={now} tz={TZ} tableNames={NAMES} customers={new Map()} selectedId={partida.selectedId} onOpen={partida.selectRow} />
              ))}
            </div>
            <PlanoReservas
              areas={AREAS}
              tables={TABLES}
              names={NAMES}
              live={live}
              selectedTableIds={partida.selected?.tableIds ?? []}
              onSelectTable={partida.selectTable}
              footer={<BarraReserva reservation={partida.selected} now={now} tz={TZ} tableNames={NAMES} api={api} onOpenDetail={(r) => toast(`Aquí se abriría el detalle de ${r.guestName}.`)} onClear={partida.clear} />}
            />
          </div>
        )}
      </Bloque>

      <Bloque title="Mesas redondas pequeñas" origin="sala/Plano (B, arreglado)">
        <Plano label="Redondas de 9, 11, 13 y 16 puntos de ancho" tables={redondas} names={new Map()} live={redondasLive} compact />
      </Bloque>
    </div>
  )
}
