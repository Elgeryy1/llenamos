"use client"

import { CircleIcon, MapTrifoldIcon, PlusIcon, SquareIcon, StorefrontIcon } from "@phosphor-icons/react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Notice } from "@/components/common/notice"
import { EmptyState } from "@/components/common/empty-state"
import { LoadingBlock } from "@/components/common/loading"
import { SegmentedControl } from "@/components/common/segmented-control"
import { SelectField } from "@/components/common/form-fields"
import { SaveBar } from "@/components/config/SaveBar"
import { LiveError } from "@/components/panel/LiveError"
import { PageHeading as PageHeader } from "@/components/common/page-heading"
import { usePanel } from "@/components/panel/PanelContext"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { AreasEditor } from "@/components/plano/AreasEditor"
import { EditorCanvas } from "@/components/plano/EditorCanvas"
import { TableInspector } from "@/components/plano/TableInspector"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useSala } from "@/lib/data/hooks"
import { describeError, type ErrorInfo } from "@/lib/firebase/errors"
import { plural } from "@/lib/format"
import * as E from "@/lib/plano/editor"
import { isVpsBackend } from "@/lib/data/backend"
import { newPlanoId, PlanoSaveError, savePlano, savePlanoCommand } from "@/lib/plano/guardar"

export function PlanoView() {
  return (
    <RequirePermission permission="plano.editar" what="el editor del plano">
      <Plano />
    </RequirePermission>
  )
}

function Plano() {
  const { restaurant, location } = usePanel()
  const sala = useSala(restaurant.id, location?.id ?? null)

  if (!location) {
    return (
      <>
        <PageHeader title="Plano" />
        <EmptyState
          icon={<StorefrontIcon />}
          title="Este restaurante aún no tiene locales"
          description="Cuando haya un local, aquí podrás dibujar sus zonas y mesas."
        />
      </>
    )
  }
  if (sala.status === "loading") {
    return (
      <>
        <PageHeader title={`Plano de ${location.name}`} />
        <LoadingBlock label="Cargando el plano…" className="flex min-w-0 flex-col gap-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="aspect-[16/10] w-full rounded-xl" />
        </LoadingBlock>
      </>
    )
  }
  if (sala.status === "error") {
    return (
      <>
        <PageHeader title={`Plano de ${location.name}`} />
        <LiveError title="No se ha podido cargar el plano" error={sala.error} />
      </>
    )
  }
  // Al cambiar de local, el editor empieza de cero.
  return <Editor key={location.id} locationId={location.id} locationName={location.name} live={sala.data} />
}

function Editor({ locationId, locationName, live }: { locationId: string; locationName: string; live: E.PlanoDraft }) {
  const { restaurant, user } = usePanel()
  const basePath = `restaurants/${restaurant.id}/locations/${locationId}`

  // Mientras no se toca nada se enseña lo guardado (y lo que cambie otra persona).
  // Al editar se guarda una foto de partida: al final solo se escribe lo que se ha tocado.
  const [start, setStart] = useState<E.PlanoDraft | null>(null)
  const [draft, setDraft] = useState<E.PlanoDraft | null>(null)
  const [areaId, setAreaId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ErrorInfo | null>(null)

  const current = draft ?? live
  const areas = E.sortedAreas(current)
  const area = areas.find((a) => a.id === areaId) ?? areas[0] ?? null
  const areaTables = area ? E.tablesOf(current, area.id) : []
  const selected = current.tables.find((t) => t.id === selectedId) ?? null
  const names = useMemo(() => new Map(current.tables.map((t) => [t.id, t.name] as const)), [current])

  const problems = useMemo(() => E.validateDraft(current), [current])
  const problemIds = useMemo(() => new Set(problems.map((p) => p.id)), [problems])
  const changes = useMemo(() => (start && draft ? E.diffDraft(start, draft) : null), [start, draft])
  const changeCount = changes ? E.countChanges(changes) : 0
  const remoteChanged = useMemo(() => (start ? E.countChanges(E.diffDraft(start, live)) > 0 : false), [start, live])
  const halfJoins = useMemo(() => E.countChanges(E.diffDraft(live, E.normalizeJoins(live))) > 0, [live])

  function edit(fn: (d: E.PlanoDraft) => E.PlanoDraft) {
    setError(null)
    setStart((s) => s ?? live)
    setDraft((d) => fn(d ?? E.normalizeJoins(live)))
  }

  function discard() {
    setStart(null)
    setDraft(null)
    setError(null)
    setSelectedId(null)
  }

  function newId() {
    return newPlanoId()
  }

  function addTable(shape: "rect" | "round") {
    if (!area) return
    const id = newId()
    edit((d) => E.addTable(d, area.id, id, shape))
    setSelectedId(id)
  }

  async function save() {
    if (!changes || problems.length > 0) return
    setPending(true)
    setError(null)
    try {
      if (isVpsBackend()) await savePlanoCommand(restaurant.id, locationId, changes)
      else await savePlano(basePath, user.uid, changes)
      setStart(null)
      setDraft(null)
      toast.success(`Plano guardado: ${plural(changeCount, "cambio", "cambios")}.`)
    } catch (e) {
      const info = describeError(e instanceof PlanoSaveError ? e.cause : e)
      setError({ ...info, message: e instanceof PlanoSaveError ? `${e.message} ${info.message}` : info.message })
    } finally {
      setPending(false)
    }
  }

  const enabled = current.tables.filter((t) => t.enabled)
  const seats = enabled.reduce((n, t) => n + t.seats, 0)

  return (
    <>
      <PageHeader
        eyebrow={locationName}
        title={`${plural(current.tables.length, "mesa", "mesas")} y ${plural(seats, "plaza", "plazas")} en ${plural(areas.length, "zona", "zonas")}`}
        description="Prepara el espacio del próximo servicio. Arrastra las mesas y ajusta sus plazas o sus uniones."
      />

      <p className="mb-4 text-xs leading-relaxed text-muted-foreground md:hidden">
        Arrastra una mesa con el dedo. Desliza el suelo para recorrer el plano.
      </p>

      {halfJoins && !draft ? (
        <Notice tone="warning" title="Hay uniones de mesas a medias" className="mb-4">
          Alguna mesa dice que se junta con otra que no la tiene marcada, o con una de otra zona. Al guardar cualquier cambio se arreglan.
        </Notice>
      ) : null}
      {remoteChanged ? (
        <Notice tone="warning" title="Alguien ha cambiado el plano mientras editabas" className="mb-4">
          Al guardar solo se escriben los datos que has tocado tú. Si quieres ver sus cambios primero, descarta los tuyos.
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error" title="No se ha guardado el plano" detail={error.code} className="mb-4">
          {error.message}
        </Notice>
      ) : null}

      {areas.length === 0 ? (
        <EmptyState
          icon={<MapTrifoldIcon />}
          title={`${locationName} aún no tiene zonas`}
          description="Empieza por crear una zona (sala, terraza, barra) y luego añade sus mesas."
          className="mb-6"
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="superficie flex min-w-0 flex-col gap-4 self-start p-4">
          {area ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              {areas.length <= 4 ? (
                <SegmentedControl
                  label="Zona del plano"
                  className="max-w-full overflow-x-auto [&_button]:pointer-coarse:min-w-11"
                  value={area.id}
                  onValueChange={(id) => {
                    setAreaId(id)
                    setSelectedId(null)
                  }}
                  options={areas.map((a) => ({ value: a.id, label: a.name || "Sin nombre" }))}
                />
              ) : (
                <SelectField
                  label="Zona"
                  value={area.id}
                  onChange={(e) => {
                    setAreaId(e.target.value)
                    setSelectedId(null)
                  }}
                >
                  {areas.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name || "Sin nombre"}
                    </option>
                  ))}
                </SelectField>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="lg" onClick={() => addTable("rect")}>
                  <SquareIcon aria-hidden />
                  <PlusIcon aria-hidden className="-ml-1 size-3" />
                  Rectangular
                </Button>
                <Button variant="outline" size="lg" onClick={() => addTable("round")}>
                  <CircleIcon aria-hidden />
                  <PlusIcon aria-hidden className="-ml-1 size-3" />
                  Redonda
                </Button>
              </div>
            </div>
          ) : null}

          {area ? (
            <EditorCanvas
              label={area.name}
              tables={areaTables}
              names={names}
              selectedId={selectedId}
              problemIds={problemIds}
              onSelect={setSelectedId}
              onMove={(id, dx, dy) => {
                const t = current.tables.find((m) => m.id === id)
                if (t) edit((d) => E.moveTable(d, id, t.x + dx, t.y + dy))
              }}
              onResize={(id, dw, dh) => {
                const t = current.tables.find((m) => m.id === id)
                if (t) edit((d) => E.resizeTable(d, id, t.w + dw, t.h + dh))
              }}
              onNudge={(id, dx, dy) => edit((d) => E.nudgeTable(d, id, dx, dy))}
            />
          ) : null}

          <p className="text-xs leading-relaxed text-muted-foreground">Toca una mesa para editarla. El asa cambia su tamaño y las flechas del teclado la mueven. Las líneas unen mesas compatibles.</p>

          {area && areaTables.length === 0 ? (
            <p className="text-sm text-muted-foreground">Esta zona aún no tiene mesas. Añade la primera con los botones de arriba.</p>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {selected ? (
            <TableInspector
              key={selected.id}
              table={selected}
              areas={areas}
              sameArea={E.tablesOf(current, selected.areaId).filter((t) => t.id !== selected.id)}
              problems={problems.filter((p) => p.id === selected.id).map((p) => p.message)}
              actions={{
                rename: (name) => edit((d) => E.renameTable(d, selected.id, name)),
                setSeats: (n) => edit((d) => E.setSeats(d, selected.id, n)),
                setShape: (shape) => edit((d) => (shape === selected.shape ? d : E.toggleShape(d, selected.id))),
                setEnabled: (on) => edit((d) => E.setEnabled(d, selected.id, on)),
                setArea: (aid) => {
                  edit((d) => E.moveTableToArea(d, selected.id, aid))
                  setAreaId(aid)
                },
                setBox: (box) =>
                  edit((d) => {
                    const fit = E.fitBox(box)
                    return E.resizeTable(E.moveTable(d, selected.id, fit.x, fit.y), selected.id, fit.w, fit.h)
                  }),
                setJoinable: (other, on) => edit((d) => E.setJoinable(d, selected.id, other, on)),
                remove: () => {
                  edit((d) => E.deleteTable(d, selected.id))
                  setSelectedId(null)
                },
              }}
            />
          ) : area ? (
            <p className="superficie p-5 text-sm leading-relaxed text-muted-foreground">
              Toca una mesa para cambiar su nombre, plazas, forma o con qué mesas se puede juntar.
            </p>
          ) : null}

          <AreasEditor
            draft={current}
            problemIds={problemIds}
            onRename={(id, name) => edit((d) => E.renameArea(d, id, name))}
            onMove={(id, dir) => edit((d) => E.moveArea(d, id, dir))}
            onDelete={(id) => edit((d) => E.deleteArea(d, id))}
            onAdd={(name) => {
              const id = newId()
              edit((d) => E.addArea(d, id, name))
              setAreaId(id)
              setSelectedId(null)
            }}
          />
        </div>
      </div>

      <SaveBar
        className="rounded-xl border bg-popover shadow-float backdrop-blur-none"
        dirty={changeCount > 0}
        pending={pending}
        disabled={problems.length > 0}
        onSave={() => void save()}
        onDiscard={discard}
        message={
          problems.length > 0
            ? `No se puede guardar: ${problems[0]?.message}${problems.length > 1 ? ` (y ${problems.length - 1} más)` : ""}`
            : `${plural(changeCount, "cambio", "cambios")} sin guardar.`
        }
      />
    </>
  )
}
