"use client"

import { useState } from "react"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Tag } from "@/components/common/tag"
import { apiFixture, CLIENTE_FIXTURE, cuentaFixture, programaFixture, premiosFixture, promocionesFixture, repiteFixture } from "@/lib/fidelizacion/fixtures"
import { catalogoFixture } from "@/lib/fidelizacion/catalogo"
import { permitido } from "@/lib/fidelizacion/api"
import { useAccesoFidelizacion } from "./Marco"
import { FichaFidelizacion } from "./FichaFidelizacion"
import { DescuentosCuenta } from "./DescuentosCuenta"
import { ProgramaVista } from "./Programa"
import { PromocionesVista } from "./Promociones"
import { RepiteVista } from "./Repite"

const vistas = [{ id: "piezas", texto: "Cliente y cuenta", permiso: "verCuentaFidelizacion" }, { id: "programa", texto: "Programa", permiso: "guardarConfiguracionFidelizacion" }, { id: "promociones", texto: "Promociones", permiso: "guardarPromocion" }, { id: "repite", texto: "Repite", permiso: "guardarAjustesRepite" }] as const
export function DemoFidelizacion() {
  const acceso = useAccesoFidelizacion()
  const [vista, cambiar] = useState("piezas")
  const opciones = vistas.filter((v) => v.id === "piezas" ? permitido(acceso, "verCuentaFidelizacion") || permitido(acceso, "verTarjetaRepite") : permitido(acceso, v.permiso))
  const props = { restaurantId: acceso.restaurant.id, acceso, api: apiFixture }
  return <div className="space-y-5">
    <Notice title="Demostración con datos de ejemplo">Los nombres, puntos, premios, promociones y la cuenta de esta página son inventados. Las acciones no guardan nada ni confirman éxitos. Para trabajar con datos reales usa las otras pestañas.</Notice>
    <div className="flex flex-wrap items-center gap-2"><Tag tone="aviso">Datos de ejemplo</Tag><span className="text-sm text-muted-foreground">Se respetan tu rol y los módulos activos.</span></div>
    <nav className="flex flex-wrap gap-2" aria-label="Ejemplos de fidelización">{opciones.map((v) => <Button key={v.id} variant={vista === v.id ? "secondary" : "ghost"} aria-pressed={vista === v.id} onClick={() => cambiar(v.id)}>{v.texto}</Button>)}</nav>
    {vista === "piezas" ? <div className="grid items-start gap-5 lg:grid-cols-2"><FichaFidelizacion restaurantId={acceso.restaurant.id} customerId={CLIENTE_FIXTURE} customerName="Clara Vidal" termsVersion={programaFixture.termsVersion} role={acceso.role} modules={acceso.modules} locationId={acceso.location?.id} sessionId="visita-ejemplo" api={apiFixture} /><DescuentosCuenta restaurantId={acceso.restaurant.id} locationId={acceso.location?.id ?? "centro"} bill={cuentaFixture} role={acceso.role} modules={acceso.modules} api={apiFixture} onBillChanged={() => { throw new Error("Una demo no puede confirmar un cambio de cuenta.") }} /></div> : null}
    {vista === "programa" ? <ProgramaVista {...props} settings={programaFixture} rewards={premiosFixture} catalogo={catalogoFixture} /> : null}
    {vista === "promociones" ? <PromocionesVista {...props} promociones={promocionesFixture} catalogo={catalogoFixture} /> : null}
    {vista === "repite" ? <RepiteVista {...props} settings={repiteFixture} /> : null}
  </div>
}
