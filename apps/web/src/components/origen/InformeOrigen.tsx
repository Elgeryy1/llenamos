"use client"

import { CALLABLE_SCHEMAS, ORIGIN_CHANNEL_LABEL, type CallableOutput } from "@llenamos/core"
import { useRef, useState } from "react"
import { CompassIcon } from "@phosphor-icons/react"
import { EmptyState } from "@/components/common/empty-state"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Button } from "@/components/ui/button"
import { usePanel } from "@/components/panel/PanelContext"
import { llamarMarketing, errorMarketing } from "@/lib/campanas/api"
import { eurosMarketing } from "@/lib/campanas/modelo"
import { MarcoCampanas, NavCampanas } from "@/components/campanas/MarcoCampanas"

export function InformeOrigenView() {
  return (
    <MarcoCampanas origen>
      <OrigenDatos />
    </MarcoCampanas>
  )
}
function OrigenDatos() {
  const { restaurant } = usePanel()
  return (
    <>
      <PageHeading
        title="De dónde vienen tus reservas"
        eyebrow={restaurant.name}
        description="Canal, campaña y anuncio del último toque de cada reserva. Sin cookies ni seguimiento entre visitas."
      />
      <NavCampanas />
      <InformeOrigen />
    </>
  )
}
export function InformeOrigen({ fixtureData }: { fixtureData?: CallableOutput<"informeOrigen"> }) {
  const { restaurant, locations } = usePanel()
  const [periodo, setPeriodo] = useState({ from: fixtureData ? "2026-10-01" : "", to: fixtureData ? "2026-10-31" : "", local: "todos" })
  const [resultado, setResultado] = useState<{ key: string; data: CallableOutput<"informeOrigen"> } | null>(
    fixtureData ? { key: JSON.stringify(periodo), data: fixtureData } : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const current = JSON.stringify(periodo)
  const data = resultado?.key === current ? resultado.data : null
  const cambiar = (v: typeof periodo) => {
    generation.current++
    setPeriodo(v)
  }
  async function consultar(e: React.FormEvent) {
    e.preventDefault()
    if (fixtureData) return
    const parsed = CALLABLE_SCHEMAS.informeOrigen.input.safeParse({
      restaurantId: restaurant.id,
      from: periodo.from,
      to: periodo.to,
      locationIds: periodo.local === "todos" ? locations.map((l) => l.id) : [periodo.local],
    })
    if (!parsed.success || locations.length === 0) {
      setError("Elige un periodo válido y un local al que tengas acceso.")
      return
    }
    const version = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const out = await llamarMarketing("informeOrigen", parsed.data)
      if (version === generation.current) setResultado({ key: current, data: out })
    } catch (err) {
      if (version === generation.current) setError(errorMarketing(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-5">
      <form className="superficie flex flex-wrap items-end gap-4 p-5" onSubmit={consultar} noValidate>
        <TextField
          label="Desde el día"
          type="date"
          value={periodo.from}
          disabled={!!fixtureData}
          onChange={(e) => cambiar({ ...periodo, from: e.target.value })}
          fieldClassName="min-w-0 flex-1 basis-36"
        />
        <TextField
          label="Hasta el día"
          type="date"
          value={periodo.to}
          disabled={!!fixtureData}
          onChange={(e) => cambiar({ ...periodo, to: e.target.value })}
          fieldClassName="min-w-0 flex-1 basis-36"
        />
        <SelectField
          label="Local"
          value={periodo.local}
          disabled={!!fixtureData}
          onChange={(e) => cambiar({ ...periodo, local: e.target.value })}
          fieldClassName="min-w-0 flex-1 basis-44"
        >
          <option value="todos">Todos los locales accesibles</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </SelectField>
        <Button size="lg" type="submit" disabled={busy || !!fixtureData}>
          {busy ? "Consultando…" : "Ver informe"}
        </Button>
      </form>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {data ? (
        <OrigenResultados data={data} />
      ) : (
        <EmptyState
          icon={<CompassIcon />}
          title="Elige un periodo para ver el origen"
          description="Las fechas siguen el día de servicio del local. Las reservas antiguas sin origen se indican aparte."
        />
      )}
    </div>
  )
}

export function OrigenResultados({ data }: { data: CallableOutput<"informeOrigen"> }) {
  const [agrupar, setAgrupar] = useState<"channel" | "campaignId" | "adId">("channel")
  const grupos = new Map<
    string,
    { name: string; reservations: number; covers: number; seated: number; noShows: number; cancelled: number; salesCents: number }
  >()
  for (const row of data.rows) {
    const key = row[agrupar] ?? ""
    const name =
      agrupar === "channel" ? ORIGIN_CHANNEL_LABEL[row.channel] : key || (agrupar === "campaignId" ? "Sin campaña" : "Sin anuncio")
    const actual = grupos.get(key) ?? { name, reservations: 0, covers: 0, seated: 0, noShows: 0, cancelled: 0, salesCents: 0 }
    for (const metric of ["reservations", "covers", "seated", "noShows", "cancelled", "salesCents"] as const) actual[metric] += row[metric]
    grupos.set(key, actual)
  }
  const rows = [...grupos.values()].sort((a, b) => b.reservations - a.reservations)
  const total = data.rows.reduce((sum, r) => sum + r.reservations, 0)
  const ventas = data.rows.reduce((sum, r) => sum + r.salesCents, 0)
  const max = Math.max(1, ...rows.map((r) => r.reservations))
  return (
    <div className="space-y-5">
      <SummaryStrip
        label="Resultado de origen"
        items={[
          { label: "Reservas con origen", value: total },
          { label: "Sin origen guardado", value: data.withoutOrigin, hint: "No se atribuyen a directo" },
          { label: "Ventas cobradas", value: <span className="text-2xl sm:text-3xl">{eurosMarketing(ventas)}</span> },
        ]}
      />
      <div className="max-w-xs">
        <SelectField label="Agrupar por" value={agrupar} onChange={(e) => setAgrupar(e.target.value as typeof agrupar)}>
          <option value="channel">Canal</option>
          <option value="campaignId">Campaña</option>
          <option value="adId">Anuncio</option>
        </SelectField>
      </div>
      {!rows.length ? (
        <EmptyState
          icon={<CompassIcon />}
          title="No hay reservas con origen en este periodo"
          description="Las reservas anteriores a esta fase pueden estar en el recuento sin origen."
        />
      ) : (
        <section className="superficie overflow-hidden" aria-label="Origen de las reservas">
          <ul className="divide-y">
            {rows.map((r) => (
              <li key={r.name} className="grid gap-4 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_2fr]">
                <div className="min-w-0">
                  <p className="break-words text-[15px] font-medium">{r.name}</p>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
                    <div className="h-full rounded-full bg-primary/70" style={{ width: `${(r.reservations / max) * 100}%` }} />
                  </div>
                </div>
                <dl className="grid grid-cols-3 gap-x-3 gap-y-3 text-sm">
                  {[
                    ["Reservas", r.reservations],
                    ["Comensales", r.covers],
                    ["Presentados", r.seated],
                    ["No presentados", r.noShows],
                    ["Canceladas", r.cancelled],
                    ["Ventas", eurosMarketing(r.salesCents)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="cifra mt-1 font-medium">{value}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-muted-foreground">
        Presentados son reservas sentadas o terminadas. Las ventas son lo cobrado de sus mesas, con IVA. Se guarda solo el dominio del
        referente y el tipo de clic, nunca la URL completa ni el identificador de clic. La atribución describe el último toque, no demuestra
        por sí sola un efecto causal.
      </p>
    </div>
  )
}
