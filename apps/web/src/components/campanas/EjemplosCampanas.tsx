"use client"

import { useState } from "react"
import { PageHeading } from "@/components/common/page-heading"
import { SegmentedControl } from "@/components/common/segmented-control"
import { InformeOrigen } from "@/components/origen/InformeOrigen"
import { CasillasPermiso, permisoInicial } from "@/components/origen/CasillasPermiso"
import {
  fixtureAjustes,
  fixtureAudiencia,
  fixtureCampanas,
  fixtureInforme,
  fixtureOrigen,
  fixtureSegmentos,
  fixtureSimulacion,
} from "@/lib/campanas/fixtures"
import { AjustesMarketing } from "./AjustesMarketing"
import { CampanasLista } from "./CampanasView"
import { MarcoCampanas, AvisoFixture } from "./MarcoCampanas"
import { SegmentosLista } from "./SegmentosView"

export function EjemplosCampanas() {
  const [vista, setVista] = useState("campanas")
  const [permiso, setPermiso] = useState(permisoInicial("fixture_2026_11"))
  return (
    <MarcoCampanas>
      <PageHeading
        title="Campañas y origen"
        eyebrow="Ejemplos de diseño · Fase 5"
        description="Datos inventados para revisar el diseño. Las operaciones están desactivadas."
      />
      <AvisoFixture />
      <SegmentedControl
        label="Vista del ejemplo"
        options={[
          { value: "campanas", label: "Campañas" },
          { value: "segmentos", label: "Segmentos" },
          { value: "origen", label: "Origen" },
          { value: "ajustes", label: "Ajustes" },
          { value: "permiso", label: "Permiso" },
        ]}
        value={vista}
        onValueChange={setVista}
        className="flex-wrap"
      />
      {vista === "campanas" ? (
        <CampanasLista
          campanas={fixtureCampanas}
          segmentos={fixtureSegmentos}
          fixture
          settings={fixtureAjustes}
          simulation={fixtureSimulacion}
          report={fixtureInforme}
        />
      ) : vista === "segmentos" ? (
        <SegmentosLista segmentos={fixtureSegmentos} fixture preview={fixtureAudiencia} />
      ) : vista === "origen" ? (
        <InformeOrigen fixtureData={fixtureOrigen} />
      ) : vista === "ajustes" ? (
        <AjustesMarketing inicial={fixtureAjustes} fixture />
      ) : (
        <section className="superficie p-5">
          <CasillasPermiso policyVersion="fixture_2026_11" policyUrl="#politica-de-ejemplo" value={permiso} onChange={setPermiso} />
        </section>
      )}
    </MarcoCampanas>
  )
}
