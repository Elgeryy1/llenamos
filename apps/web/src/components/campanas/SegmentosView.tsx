"use client"

import { SegmentInputSchema, type CallableOutput, type SegmentRule } from "@llenamos/core"
import { CaretRightIcon, PlusIcon, UsersThreeIcon } from "@phosphor-icons/react"
import { useRef, useState } from "react"
import { toast } from "sonner"
import { EmptyState } from "@/components/common/empty-state"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { usePanel } from "@/components/panel/PanelContext"
import { llamarMarketing, errorMarketing } from "@/lib/campanas/api"
import { useSegmentos, type Segmento } from "@/lib/campanas/datos"
import { reglaInicial } from "@/lib/campanas/modelo"
import { useOperacionMarketing } from "@/lib/campanas/useOperacion"
import { Audiencia } from "./Audiencia"
import { ErrorLectura, MarcoCampanas, NavCampanas } from "./MarcoCampanas"

export function SegmentosView() {
  return (
    <MarcoCampanas>
      <SegmentosDatos />
    </MarcoCampanas>
  )
}
function SegmentosDatos() {
  const { restaurant } = usePanel()
  const live = useSegmentos(restaurant.id)
  return (
    <>
      <PageHeading
        title="Cada mensaje, a quien le interesa"
        eyebrow={restaurant.name}
        description="Define el grupo y comprueba cuántas personas pueden recibirlo. No se muestran teléfonos ni correos."
      />
      <NavCampanas />
      {live.status === "error" ? (
        <ErrorLectura error={live.error} />
      ) : live.status === "loading" ? (
        <LoadingBlock label="Cargando segmentos" />
      ) : (
        <SegmentosLista segmentos={live.data} />
      )}
    </>
  )
}
export function SegmentosLista({
  segmentos,
  fixture = false,
  preview,
}: {
  segmentos: Segmento[]
  fixture?: boolean
  preview?: CallableOutput<"previsualizarSegmento">
}) {
  const [editor, setEditor] = useState<{ segmento: Segmento | null } | null>(null)
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="lg" onClick={() => setEditor({ segmento: null })} disabled={fixture}>
          <PlusIcon aria-hidden /> Nuevo segmento
        </Button>
      </div>
      {segmentos.length ? (
        <section className="superficie overflow-hidden">
          <ul className="divide-y">
            {segmentos.map((s) => (
              <li key={s.id}>
                <button
                  className="flex min-h-20 w-full items-center justify-between gap-4 px-5 py-4 text-left hover:bg-surface-raised"
                  onClick={() => setEditor({ segmento: s })}
                >
                  <span>
                    <span className="block text-[15px] font-medium">{s.name}</span>
                    <span className="text-xs text-muted-foreground">Condiciones combinadas · revisión {s.revision}</span>
                  </span>
                  <CaretRightIcon aria-hidden className="shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <EmptyState
          icon={<UsersThreeIcon />}
          title="Aún no tienes segmentos"
          description="Crea un grupo con visitas, etiquetas o tiempo desde la última visita."
        />
      )}
      {editor ? (
        <SegmentoEditor
          key={editor.segmento?.id ?? "nuevo"}
          actual={editor.segmento}
          fixture={fixture}
          fixturePreview={preview}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </div>
  )
}

export function SegmentoEditor({
  actual,
  onClose,
  fixture = false,
  fixturePreview,
}: {
  actual: Segmento | null
  onClose: () => void
  fixture?: boolean
  fixturePreview?: CallableOutput<"previsualizarSegmento">
}) {
  const { restaurant } = usePanel()
  const [name, setName] = useState(actual?.name ?? "")
  const [rule, setRule] = useState<SegmentRule>(actual?.rule ?? reglaInicial)
  const [channel, setChannel] = useState<"email" | "whatsapp">("email")
  const [preview, setPreview] = useState(fixturePreview ?? null)
  const [loading, setLoading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const generation = useRef(0)
  const op = useOperacionMarketing()
  const cambiar = (next: SegmentRule) => {
    generation.current++
    setRule(next)
    setPreview(null)
  }
  const reglaLimpia = () => ({
    ...rule,
    tagsAny: rule.tagsAny.map((t) => t.trim()).filter(Boolean),
    tagsNone: rule.tagsNone.map((t) => t.trim()).filter(Boolean),
  })
  async function previsualizar() {
    const parsed = SegmentInputSchema.safeParse({ name: name || "Vista previa", rule: reglaLimpia() })
    if (!parsed.success) {
      op.fail("Revisa las condiciones. Los mínimos no pueden superar los máximos.")
      return
    }
    if (fixture) {
      setPreview(fixturePreview ?? null)
      return
    }
    const version = ++generation.current
    setLoading(true)
    op.fail(null)
    try {
      const out = await llamarMarketing("previsualizarSegmento", { restaurantId: restaurant.id, rule: parsed.data.rule, channel })
      if (version === generation.current) setPreview(out)
    } catch (error) {
      if (version === generation.current) op.fail(errorMarketing(error))
    } finally {
      setLoading(false)
    }
  }
  async function guardar(e: React.FormEvent) {
    e.preventDefault()
    if (fixture) return
    const parsed = SegmentInputSchema.safeParse({ name, rule: reglaLimpia() })
    if (!parsed.success) {
      op.fail("Escribe un nombre y revisa las condiciones del segmento.")
      return
    }
    const out = await op.run("guardarSegmento", {
      restaurantId: restaurant.id,
      segmentId: actual?.id ?? null,
      expectedRevision: actual?.revision ?? null,
      segment: parsed.data,
    })
    if (out) {
      toast.success("Segmento guardado")
      onClose()
    }
  }
  async function borrar() {
    if (!actual || fixture) return
    const out = await op.run("borrarSegmento", { restaurantId: restaurant.id, segmentId: actual.id, expectedRevision: actual.revision })
    if (out) {
      toast.success("Segmento borrado")
      onClose()
    }
  }
  const numeros: Array<
    [
      keyof Pick<
        SegmentRule,
        "minVisits" | "maxVisits" | "lastVisitAtLeastDaysAgo" | "lastVisitAtMostDaysAgo" | "maxNoShows" | "minSpentCents" | "minPoints"
      >,
      string,
    ]
  > = [
    ["minVisits", "Visitas mínimas"],
    ["maxVisits", "Visitas máximas"],
    ["lastVisitAtLeastDaysAgo", "Última visita hace al menos (días)"],
    ["lastVisitAtMostDaysAgo", "Última visita hace como mucho (días)"],
    ["maxNoShows", "Máximo de no presentados"],
    ["minSpentCents", "Gasto mínimo (céntimos)"],
    ["minPoints", "Puntos mínimos"],
  ]
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle>{actual ? actual.name : "Nuevo segmento"}</SheetTitle>
          <SheetDescription>Todas las condiciones deben cumplirse. Un campo vacío no limita el grupo.</SheetDescription>
        </SheetHeader>
        <form className="space-y-5 p-5" noValidate onSubmit={guardar}>
          <fieldset disabled={op.busy || fixture} className="space-y-4">
            <TextField label="Nombre del segmento" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            <div className="grid gap-4 sm:grid-cols-2">
              {numeros.map(([key, label]) => (
                <TextField
                  key={key}
                  label={label}
                  type="number"
                  min={0}
                  step={1}
                  value={rule[key] ?? ""}
                  onChange={(e) => cambiar({ ...rule, [key]: e.target.value === "" ? null : Number(e.target.value) })}
                />
              ))}
            </div>
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <Checkbox checked={rule.includeNeverVisited} onCheckedChange={(v) => cambiar({ ...rule, includeNeverVisited: v === true })} />{" "}
              Incluir a quien nunca ha venido
            </label>
            {(
              [
                ["tagsAny", "Alguna de estas etiquetas"],
                ["tagsNone", "Ninguna de estas etiquetas"],
              ] as const
            ).map(([key, label]) => (
              <TextField
                key={key}
                label={label}
                value={rule[key].join(",")}
                onChange={(e) => cambiar({ ...rule, [key]: e.target.value.split(",") })}
                hint="Separa las etiquetas con comas."
              />
            ))}
            <fieldset>
              <legend className="mb-2 text-sm">Idiomas (ninguno elegido incluye todos)</legend>
              <div className="flex flex-wrap gap-4">
                {(
                  [
                    ["es", "Castellano"],
                    ["ca", "Catalán"],
                    ["en", "Inglés"],
                  ] as const
                ).map(([key, label]) => (
                  <label className="flex min-h-11 items-center gap-2 text-sm" key={key}>
                    <Checkbox
                      checked={rule.languages.includes(key)}
                      onCheckedChange={(v) =>
                        cambiar({ ...rule, languages: v === true ? [...rule.languages, key] : rule.languages.filter((x) => x !== key) })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          </fieldset>
          <SelectField
            label="Canal de la vista previa"
            value={channel}
            onChange={(e) => {
              generation.current++
              setChannel(e.target.value as typeof channel)
              setPreview(null)
            }}
          >
            <option value="email">Correo</option>
            <option value="whatsapp">WhatsApp</option>
          </SelectField>
          <Button type="button" variant="outline" disabled={loading || op.busy} onClick={previsualizar}>
            {loading ? "Calculando…" : "Previsualizar audiencia"}
          </Button>
          {preview ? <Audiencia data={preview} /> : null}
          {op.error ? <Notice tone="error">{op.error}</Notice> : null}
          <div className="flex flex-wrap gap-3 border-t pt-4">
            <Button size="lg" type="submit" disabled={op.busy || fixture}>
              Guardar segmento
            </Button>
            {actual ? (
              <Button type="button" variant="outline" disabled={op.busy || fixture} onClick={() => setConfirmDelete(true)}>
                Borrar segmento
              </Button>
            ) : null}
          </div>
          {confirmDelete ? (
            <Notice tone="warning" title="¿Borrar este segmento?">
              El servidor impedirá borrarlo si una campaña lo necesita.
              <div className="mt-3 flex gap-2">
                <Button type="button" variant="destructive" disabled={op.busy} onClick={borrar}>
                  Confirmar borrado
                </Button>
                <Button type="button" variant="outline" onClick={() => setConfirmDelete(false)}>
                  Conservar
                </Button>
              </div>
            </Notice>
          ) : null}
        </form>
      </SheetContent>
    </Sheet>
  )
}
