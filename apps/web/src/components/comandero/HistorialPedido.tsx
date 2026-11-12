"use client"

import {
  COURSE_LABEL,
  LINE_STATUS_LABEL,
  can,
  checkLineTransition,
  type Course,
  type OrderLineWithId,
} from "@llenamos/core"
import { useState } from "react"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/common/notice"
import { llamarSala } from "@/lib/comandero/callables"
import { useDestino, type Alcance } from "@/lib/comandero/datos"
import { euros } from "@/lib/comandero/modelo"
import { EstadoLectura, useOperacion } from "./Servicio"

export function HistorialPedido({
  scope,
  kind,
  id,
  active,
}: {
  scope: Alcance
  kind: "sessionId" | "takeawayId"
  id: string
  active: boolean
}) {
  const { role } = usePanel()
  const { lines, orders } = useDestino(scope, kind, id)
  const [reason, setReason] = useState("")
  const op = useOperacion()
  const marchar = (course: Course | "all" | null) =>
    op.run(async () => {
      await llamarSala("marcharPase", { ...scope, [kind]: id, course })
      return "Pase marchado."
    })
  const change = (
    line: OrderLineWithId,
    status: "served" | "cancelled" | "ready" | "held" | "fired",
  ) =>
    op.run(async () => {
      await llamarSala("cambiarEstadoLineas", {
        ...scope,
        lineIds: [line.id],
        status,
        reason: reason.trim() || null,
      })
      setReason("")
      return "Estado del plato actualizado."
    })
  return (
    <section className="superficie space-y-4 p-4" aria-label="Pedidos enviados">
      <h2 className="text-lg font-semibold">Lo que ya está pedido</h2>
      {op.feedback}
      <label className="block text-sm">
        Motivo para rechazar o anular
        <Input
          className="h-12"
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <EstadoLectura live={orders} label="los pedidos">
        {(data) => (
          <>
            {data
              .filter((o) => o.status === "pending_approval")
              .map((o) => (
                <div
                  key={o.id}
                  className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-3"
                >
                  <p>
                    Pedido pendiente de aprobación ·{" "}
                    <span className="cifra">{euros(o.totalCents)}</span>
                  </p>
                  {o.note ? <p>{o.note}</p> : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className="h-12"
                      variant="outline"
                      disabled={!active || op.busy}
                      onClick={() =>
                        void op.run(async () => {
                          await llamarSala("decidirPedido", {
                            ...scope,
                            orderId: o.id,
                            decision: "accept",
                          })
                          return "Pedido aceptado con su precio original."
                        })
                      }
                    >
                      Aceptar pedido
                    </Button>
                    <Button
                      className="h-12"
                      variant="outline"
                      disabled={!active || op.busy || !reason.trim()}
                      onClick={() =>
                        void op.run(async () => {
                          await llamarSala("decidirPedido", {
                            ...scope,
                            orderId: o.id,
                            decision: "reject",
                            reason,
                          })
                          setReason("")
                          return "Pedido rechazado."
                        })
                      }
                    >
                      Rechazar con motivo
                    </Button>
                  </div>
                </div>
              ))}
          </>
        )}
      </EstadoLectura>
      <EstadoLectura live={lines} label="los platos enviados">
        {(data) => {
          const held = data.filter(
            (l) => l.status === "held" && l.kind !== "menu",
          )
          const pendingTotal = data
            .filter((l) => l.status === "pending")
            .reduce((n, l) => n + l.totalCents, 0)
          return (
            <>
              {pendingTotal > 0 ? (
                <Notice tone="warning">
                  {euros(pendingTotal)} pendientes de aprobación. Consumo
                  registrado, todavía no cobrado.
                </Notice>
              ) : null}
              {held.length ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="h-12"
                    variant="outline"
                    disabled={!active || op.busy}
                    onClick={() => void marchar(null)}
                  >
                    Marchar siguiente pase
                  </Button>
                  {Array.from(
                    new Set(
                      held
                        .map((l) => l.course)
                        .filter((c): c is Course => c !== null),
                    ),
                  ).map((c) => (
                    <Button
                      key={c}
                      className="h-12"
                      variant="outline"
                      disabled={!active || op.busy}
                      onClick={() => void marchar(c)}
                    >
                      Marchar {COURSE_LABEL.es[c].toLocaleLowerCase("es")}
                    </Button>
                  ))}
                  <Button
                    className="h-12"
                    variant="outline"
                    disabled={!active || op.busy}
                    onClick={() => void marchar("all")}
                  >
                    Marchar todo
                  </Button>
                </div>
              ) : null}
              {!data.length ? (
                <p className="text-sm text-muted-foreground">
                  Todavía no hay platos enviados.
                </p>
              ) : (
                <ul className="divide-y">
                  {[...data]
                    .sort(
                      (a, b) =>
                        a.placedAt - b.placedAt || a.position - b.position,
                    )
                    .map((l) => (
                      <li
                        key={l.id}
                        className={`space-y-2 py-3 ${l.kind === "menu_component" ? "pl-4 border-l" : ""}`}
                      >
                        <div className="flex flex-wrap justify-between gap-2">
                          <p className="font-medium">
                            {l.quantity} × {l.name.es}
                            {l.variant ? ` · ${l.variant.name.es}` : ""}
                          </p>
                          <span
                            className={
                              l.status === "ready"
                                ? "text-success"
                                : l.status === "pending"
                                  ? "text-warning"
                                  : "text-muted-foreground"
                            }
                          >
                            ● {LINE_STATUS_LABEL[l.status]}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {l.modifiers.map((m) => m.name.es).join(", ")}
                          {l.course ? ` · ${COURSE_LABEL.es[l.course]}` : ""}
                          {l.kind !== "menu" && !l.stationId
                            ? " · Lo atiende la sala"
                            : ""}
                          {l.guest ? ` · Comensal ${l.guest}` : ""}
                        </p>
                        {l.notes ? <p className="text-sm">{l.notes}</p> : null}
                        <p className="cifra text-sm">{euros(l.totalCents)}</p>
                        <div className="flex flex-wrap gap-2">
                          {(
                            [
                              ["served", "Servido"],
                              ["ready", "Deshacer servido"],
                              ["fired", "Marchar plato"],
                              ["held", "Retener plato"],
                              ["cancelled", "Anular"],
                            ] as const
                          )
                            .filter(
                              ([status]) =>
                                l.status !== "pending" &&
                                (status !== "ready" || l.status === "served") &&
                                checkLineTransition(
                                  l,
                                  status,
                                  (p) => can(role, p),
                                  status === "cancelled"
                                    ? reason || "motivo"
                                    : null,
                                ).ok,
                            )
                            .map(([status, label]) => (
                              <Button
                                type="button"
                                key={status}
                                className="h-12"
                                variant="outline"
                                disabled={
                                  !active ||
                                  op.busy ||
                                  (status === "cancelled" && !reason.trim())
                                }
                                onClick={() => void change(l, status)}
                              >
                                {label}
                              </Button>
                            ))}
                        </div>
                      </li>
                    ))}
                </ul>
              )}
            </>
          )
        }}
      </EstadoLectura>
    </section>
  )
}
