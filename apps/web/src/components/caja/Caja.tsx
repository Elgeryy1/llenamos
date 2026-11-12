"use client"

import { ResumenEfectivo } from "@/components/sin-conexion/ResumenEfectivo"
import { useState } from "react"
import { can, type CallableOutput } from "@llenamos/core"
import {
  CashRegisterIcon,
  ReceiptIcon,
  WalletIcon,
} from "@phosphor-icons/react"
import { usePanel } from "@/components/panel/PanelContext"
import { RequireModule } from "@/components/panel/RequireModule"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { PageHeading } from "@/components/common/page-heading"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { useIncidenciasMoviles, useTurnos, type Scope } from "@/lib/caja/datos"
import { useOperacionCaja } from "@/lib/caja/useOperacion"
import { euros } from "@/lib/caja/modelo"
import { AvisoFiscal, Campo, ResultadoOperacion, Selector } from "./piezas"
import { Cuentas } from "./Cuenta"
import { Turno } from "./Turno"
import { Historial } from "./Historial"

export function Caja() {
  const { restaurant, location } = usePanel()
  return (
    <RequirePermission permission="caja.ver" what="la caja">
      <RequireModule module="pos">
        <AvisoFiscal />
        {location ? (
          <CajaLocal
            key={`${restaurant.id}:${location.id}`}
            scope={{ restaurantId: restaurant.id, locationId: location.id }}
          />
        ) : (
          <Notice>Elige un local para abrir la caja.</Notice>
        )}
      </RequireModule>
    </RequirePermission>
  )
}
function CajaLocal({ scope }: { scope: Scope }) {
  const { user, role, location } = usePanel()
  const [tab, setTab] = useState("cuentas"),
    [billId, setBillId] = useState<string | null>(null),
    [selectedCash, setCash] = useState(""),
    [count, setCount] = useState(30)
  const sessions = useTurnos(scope, can(role, "caja.gestionar"), count)
  const incidents = useIncidenciasMoviles(scope, can(role, "caja.gestionar"))
  const op = useOperacionCaja(scope, user.uid)
  const opened =
    sessions.status === "ready" && sessions.fresh
      ? sessions.data.filter((s) => s.status === "open")
      : []
  const cashSessionId = can(role, "caja.gestionar")
    ? (opened.find((s) => s.id === selectedCash)?.id ?? opened[0]?.id ?? "")
    : selectedCash
  const recoveredBillId =
    op.result?.name === "abrirCuenta"
      ? (op.result.data as CallableOutput<"abrirCuenta">).billId
      : null
  return (
    <div className="mt-5 space-y-5">
      <PageHeading
        title="La caja del servicio"
        eyebrow={location?.name}
        description="Cuentas claras, cobros por partes y arqueo del turno."
      />
      <div className="superficie flex flex-col gap-4 p-4 sm:flex-row sm:items-end sm:justify-between">
        <nav className="flex flex-wrap gap-2" aria-label="Caja">
          {[
            { value: "cuentas", label: "Cuentas", Icon: WalletIcon },
            { value: "turno", label: "Caja y arqueo", Icon: CashRegisterIcon },
            { value: "historial", label: "Historial", Icon: ReceiptIcon },
          ].map(({ value, label, Icon }) => (
            <Button
              key={value}
              className="min-h-12 px-3"
              variant={tab === value ? "secondary" : "ghost"}
              aria-pressed={tab === value}
              onClick={() => setTab(value)}
            >
              <Icon aria-hidden />
              {label}
            </Button>
          ))}
        </nav>
        <div className="w-full sm:max-w-72">
          {can(role, "caja.gestionar") ? (
            <Selector
              label="Caja para los cobros"
              value={cashSessionId}
              onChange={setCash}
              options={opened.map((s) => ({
                value: s.id,
                label: `${s.registerId} · abierta`,
              }))}
            />
          ) : (
            <Campo
              label="Referencia de la caja abierta"
              value={selectedCash}
              onChange={setCash}
              hint="El encargado puede copiarla desde Caja y arqueo."
            />
          )}
        </div>
      </div>
      <ResumenEfectivo />
      {can(role, "caja.gestionar") && incidents.status === "error" ? <Notice tone="error">No se pueden consultar las incidencias de pago móvil.</Notice> : null}
      {incidents.status === "ready" && incidents.data.length ? (
        <Notice tone="warning" title="Pagos móviles que requieren revisión">
          <ul>{incidents.data.map(i => <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">{i.summary}
            <Button type="button" size="sm" variant="outline" disabled={op.blocked} onClick={() => { void op.run("resolverIncidenciaMovil", { incidentId: i.id, reason: "Revisado con el proveedor" }, () => "Incidencia dada por revisada.") }}>Dar por revisada</Button></li>)}</ul>
          Consulta al proveedor antes de liberar el saldo o devolverlo.
        </Notice>
      ) : null}
      <ResultadoOperacion op={op} />
      {op.result?.name === "registrarCobro" ? (
        <div className="superficie p-5" role="status">
          <p className="text-sm">Cambio confirmado por el servidor</p>
          <p className="cifra mt-2 text-4xl text-primary">
            {euros(
              (op.result.data as CallableOutput<"registrarCobro">).changeCents,
            )}
          </p>
        </div>
      ) : null}
      {tab === "cuentas" ? (
        <Cuentas
          scope={scope}
          op={op}
          cashSessionId={cashSessionId}
          billId={billId ?? recoveredBillId}
          setBillId={setBillId}
        />
      ) : tab === "turno" ? (
        <Turno
          scope={scope}
          op={op}
          sessions={sessions}
          more={() => setCount(count + 30)}
        />
      ) : (
        <Historial
          scope={scope}
          op={op}
          onCuenta={(id) => {
            setBillId(id)
            setTab("cuentas")
          }}
        />
      )}
    </div>
  )
}
