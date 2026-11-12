"use client"

import { type CallableOutput, type MarketingSettings } from "@llenamos/core"
import { CaretRightIcon, EnvelopeSimpleIcon, MegaphoneIcon, PlusIcon, WhatsappLogoIcon } from "@phosphor-icons/react"
import { useState } from "react"
import { EmptyState } from "@/components/common/empty-state"
import { LoadingBlock } from "@/components/common/loading"
import { PageHeading } from "@/components/common/page-heading"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Tag } from "@/components/common/tag"
import { Button } from "@/components/ui/button"
import { usePanel } from "@/components/panel/PanelContext"
import { useCampanas, useSegmentos, useAjustesMarketing, type Campana, type Segmento } from "@/lib/campanas/datos"
import { ESTADO_CAMPANA } from "@/lib/campanas/modelo"
import { CampanaEditor } from "./CampanaEditor"
import { CampanaDetalle } from "./CampanaDetalle"
import { ErrorLectura, MarcoCampanas, NavCampanas } from "./MarcoCampanas"

export function CampanasView() {
  return (
    <MarcoCampanas>
      <CampanasDatos />
    </MarcoCampanas>
  )
}
function CampanasDatos() {
  const { restaurant } = usePanel()
  const campaigns = useCampanas(restaurant.id)
  const segments = useSegmentos(restaurant.id)
  const settings = useAjustesMarketing(restaurant.id)
  const error = [campaigns, segments, settings].find((x) => x.status === "error")
  return (
    <>
      <PageHeading
        title="Un motivo para volver a tu mesa"
        eyebrow={restaurant.name}
        description="Prepara campañas para clientes que dieron permiso. Simula el mensaje y revisa a quién llegará antes de programarlo."
      />
      <NavCampanas />
      {error?.status === "error" ? (
        <ErrorLectura error={error.error} />
      ) : campaigns.status !== "ready" || segments.status !== "ready" || settings.status !== "ready" ? (
        <LoadingBlock label="Cargando campañas" />
      ) : (
        <CampanasLista campanas={campaigns.data} segmentos={segments.data} settings={settings.data} />
      )}
    </>
  )
}

export function CampanasLista({
  campanas,
  segmentos,
  fixture = false,
  simulation,
  report,
  settings,
}: {
  campanas: Campana[]
  segmentos: Segmento[]
  settings?: MarketingSettings | null
  fixture?: boolean
  simulation?: CallableOutput<"simularCampana">
  report?: CallableOutput<"informeCampana">
}) {
  const [elegida, setElegida] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ actual: Campana | null } | null>(null)
  const actual = campanas.find((c) => c.id === elegida)
  return (
    <div className="space-y-5">
      <SummaryStrip
        label="Estado de las campañas"
        items={[
          { label: "En borrador", value: campanas.filter((c) => c.status === "draft").length },
          { label: "Programadas", value: campanas.filter((c) => c.status === "scheduled").length, tone: "warning" },
          {
            label: "Preparación terminada",
            value: campanas.filter((c) => c.status === "sent").length,
            hint: "Consulta el informe de entregas",
          },
        ]}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Tus campañas</h2>
        <Button size="lg" disabled={fixture || segmentos.length === 0} onClick={() => setEditor({ actual: null })}>
          <PlusIcon aria-hidden /> Nueva campaña
        </Button>
      </div>
      {segmentos.length === 0 ? <p className="text-sm text-muted-foreground">Crea primero un segmento en la pestaña Segmentos.</p> : null}
      {campanas.length ? (
        <section className="superficie overflow-hidden">
          <ul className="divide-y">
            {campanas
              .toSorted((a, b) => a.name.localeCompare(b.name, "es"))
              .map((c) => (
                <li key={c.id}>
                  <button
                    className="flex min-h-24 w-full items-center gap-4 px-5 py-4 text-left hover:bg-surface-raised"
                    onClick={() => setElegida(c.id)}
                  >
                    <span className="hidden size-11 shrink-0 items-center justify-center rounded-full bg-surface-raised text-muted-foreground sm:flex">
                      {c.channel === "email" ? <EnvelopeSimpleIcon aria-hidden size={22} /> : <WhatsappLogoIcon aria-hidden size={22} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="text-[15px] font-medium">{c.name}</span>
                        <Tag tone={c.status === "scheduled" ? "aviso" : "neutro"}>
                          <span aria-hidden className="mr-1">
                            ●
                          </span>
                          {ESTADO_CAMPANA[c.status]}
                        </Tag>
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {c.channel === "email" ? "Correo" : "WhatsApp"} ·{" "}
                        {segmentos.find((s) => s.id === c.segmentId)?.name ?? "Segmento no disponible"}
                      </span>
                    </span>
                    <CaretRightIcon aria-hidden className="shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ) : (
        <EmptyState
          icon={<MegaphoneIcon />}
          title="Tu primera campaña empieza con un borrador"
          description="Solo se programa después de guardarla y revisarla. El encargado puede prepararla y el propietario la lanza."
        />
      )}
      {actual ? (
        <CampanaDetalle
          key={actual.id}
          actual={actual}
          settings={settings}
          fixture={fixture}
          fixtureSimulation={actual.status === "draft" && actual.channel === "email" ? simulation : undefined}
          fixtureReport={actual.status === "sent" ? report : undefined}
          onClose={() => setElegida(null)}
          onEdit={() => {
            setElegida(null)
            setEditor({ actual })
          }}
        />
      ) : null}
      {editor ? (
        <CampanaEditor key={editor.actual?.id ?? "nueva"} actual={editor.actual} segmentos={segmentos} onClose={() => setEditor(null)} />
      ) : null}
    </div>
  )
}
