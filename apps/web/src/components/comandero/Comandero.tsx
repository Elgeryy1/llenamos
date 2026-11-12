"use client"

import { ColaServicio } from "@/components/sin-conexion/ColaServicio"
import { sessionIsOpen, type TableSessionWithId } from "@llenamos/core"
import { useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"
import { Desplegable } from "@/components/common/desplegable"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { SummaryStrip } from "@/components/common/summary-strip"
import { usePanel } from "@/components/panel/PanelContext"
import { RequireModule } from "@/components/panel/RequireModule"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { TareasSala } from "@/components/tareas/TareasSala"
import { Button } from "@/components/ui/button"
import { llamarSala } from "@/lib/comandero/callables"
import { useCarta, useMesas, useDestino, type Alcance } from "@/lib/comandero/datos"
import {
  euros,
  firmaMesa,
  problemasPedido,
  revisarDestino,
} from "@/lib/comandero/modelo"
import { repetirRonda } from "@/lib/comandero/servicio"
import { useNow } from "@/lib/reservas/hooks"
import { timeOf } from "@/lib/reservas/formato"
import { AbrirMesa, GestionMesa } from "./GestionMesa"
import { HistorialPedido } from "./HistorialPedido"
import { Pedido } from "./Pedido"
import { EnlacesServicio, EstadoLectura } from "./Servicio"

export function Comandero() {
  const { restaurant, location } = usePanel()
  return (
    <RequirePermission permission="comandas.tomar" what="el comandero">
      <RequireModule module="floor">
        {location ? (
          <ComanderoLocal
            key={`${restaurant.id}/${location.id}`}
            scope={{ restaurantId: restaurant.id, locationId: location.id }}
          />
        ) : (
          <Notice>Elige un local para tomar pedidos.</Notice>
        )}
      </RequireModule>
    </RequirePermission>
  )
}

function ComanderoLocal({ scope }: { scope: Alcance }) {
  const { restaurant, location } = usePanel()
  const params = useSearchParams()
  const router = useRouter()
  const [selected, setSelected] = useState<string | null>(params.get("s"))
  const [lastQuery, setLastQuery] = useState(params.get("s"))
  if (lastQuery !== params.get("s")) {
    setLastQuery(params.get("s"))
    setSelected(params.get("s"))
  }
  const choose = (id: string) => {
    setSelected(id)
    router.replace(`/panel/comandero?s=${encodeURIComponent(id)}`, {
      scroll: false,
    })
  }
  const [open, setOpen] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const now = useNow()
  const sessions = useMesas(scope)
  const carta = useCarta(scope)
  const session =
    sessions.status === "ready"
      ? (sessions.data.find((s) => s.id === selected) ?? null)
      : null
  const active =
    sessions.status === "ready"
      ? sessions.data.filter((s) => sessionIsOpen(s.status))
      : []
  return (
    <div className="space-y-5">
      <PageHeading
        title="Un pedido, pocos toques"
        eyebrow={`${location?.name} · En directo · ${timeOf(now, restaurant.timezone)}`}
        description="Elige una mesa, toma nota y envía cada pase cuando toque."
        actions={
          <Button
            variant={selected ? "outline" : "default"}
            className="h-12"
            onClick={() => setOpen(!open)}
          >
            {open ? "Cerrar apertura" : "Abrir mesa o sentar"}
          </Button>
        }
      />
      <EnlacesServicio />
      {warning ? <Notice tone="warning">{warning}</Notice> : null}
      <SummaryStrip
        label="Servicio de sala"
        items={[
          {
            label: "Mesas abiertas",
            value: sessions.status === "ready" ? active.length : "…",
          },
          {
            label: "Personas",
            value:
              sessions.status === "ready"
                ? active.reduce((n, s) => n + s.guests, 0)
                : "…",
            loading: sessions.status === "loading",
          },
          {
            label: "Consumo registrado",
            value:
              sessions.status === "ready"
                ? euros(active.reduce((n, s) => n + s.totalCents, 0))
                : "…",
            loading: sessions.status === "loading",
            hint: "No indica dinero cobrado",
          },
        ]}
      />
      {open ? (
        <section className="superficie space-y-4 p-4">
          <h2 className="text-lg font-semibold">
            Abrir mesa o sentar una reserva
          </h2>
          <AbrirMesa
            scope={scope}
            onOpened={(id, note) => {
              choose(id)
              setWarning(note)
              setOpen(false)
            }}
          />
        </section>
      ) : null}
      <EstadoLectura live={sessions} label="las sesiones de mesa">
        {(data) => (
          <label className="block max-w-xl text-sm">
            Mesa del pedido
            <Desplegable
              className="min-h-12"
              value={selected ?? ""}
              onChange={(e) => choose(e.target.value)}
            >
              <option value="">Elige una mesa abierta</option>
              {data
                .filter((s) => sessionIsOpen(s.status) || s.status === "closed")
                .sort(
                  (a, b) =>
                    Number(sessionIsOpen(b.status)) -
                      Number(sessionIsOpen(a.status)) ||
                    b.openedAt - a.openedAt,
                )
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label} · {s.guests} personas
                    {s.guestName ? ` · ${s.guestName}` : ""}
                    {!sessionIsOpen(s.status) ? " · Cerrada" : ""}
                  </option>
                ))}
            </Desplegable>
          </label>
        )}
      </EstadoLectura>
      {selected ? (
        <MesaPedido
          key={selected}
          scope={scope}
          session={session}
          ready={sessions.status === "ready"}
          carta={carta}
          now={now}
        />
      ) : (
        <Notice>
          Elige una mesa abierta o abre una nueva para empezar a pedir.
        </Notice>
      )}
      <TareasSala scope={scope} />
    </div>
  )
}

export function MesaPedido({
  scope,
  session,
  ready,
  carta,
  now,
}: {
  scope: Alcance
  session: TableSessionWithId | null
  ready: boolean
  carta: ReturnType<typeof useCarta>
  now: number
}) {
  const { restaurant, user } = usePanel()
  const history = useDestino(scope, "sessionId", session?.id ?? "sin-sesion")
  const [original, setOriginal] = useState<string | null>(null)
  const [lastCarta, setLastCarta] = useState(
    carta.status === "ready" ? carta.data : null,
  )
  if (carta.status === "ready" && lastCarta !== carta.data)
    setLastCarta(carta.data)
  // El primer dato recibido fija el destino, nunca el de un movimiento posterior.
  if (original === null && session) setOriginal(firmaMesa(session))
  const blocked = !ready
    ? "No se puede comprobar el estado actual de la mesa. El pedido sigue sin enviar."
    : carta.status !== "ready"
      ? "No se puede comprobar la carta actual. Conservamos tu pedido sin enviarlo."
      : original
        ? revisarDestino(original, session)
        : "No se encuentra esta mesa."
  return (
    <div className="space-y-5">
      <ColaServicio entities={session ? [{ kind: "session", id: session.id, observed: session }] : []} />
      {session ? (
        <>
          <h2 className="text-xl font-semibold">
            {session.label} · {session.guests} personas{" "}
            <span className="text-sm font-normal text-muted-foreground">
              {session.guestName ?? "Sin cliente asociado"} ·{" "}
              {session.waiterName ?? "Sin responsable"}
            </span>
          </h2>
          <GestionMesa
            key={firmaMesa(session)}
            scope={scope}
            session={session}
          />
        </>
      ) : null}
      <EstadoLectura live={carta} label="la carta">
        {() => null}
      </EstadoLectura>
      {lastCarta && session ? (
        <Pedido
          repeatLines={history.lines.status === "ready" ? repetirRonda(history.lines.data) : []}
          draftKey={session ? `llenamos:comandero:${user?.uid}:${scope.restaurantId}:${scope.locationId}:${session.id}` : undefined}
          destination={session ? firmaMesa(session) : undefined}
          carta={lastCarta}
          timezone={restaurant.timezone}
          now={now}
          blocked={blocked}
          review={
            session && sessionIsOpen(session.status) ? (
              <Button
                className="mt-3 h-12"
                variant="outline"
                onClick={() => setOriginal(firmaMesa(session))}
              >
                He revisado esta mesa
              </Button>
            ) : undefined
          }
          onSend={async (lines, total, fire, note, requestId, expectedDestination, expectedPrices) => {
            if (!session) throw new Error("No se encuentra la sesión.")
            const result = await llamarSala("enviarPedido", {
              ...scope,
              sessionId: session.id,
              requestId, expectedDestination, expectedPrices,
              lines,
              expectedTotalCents: total,
              fire,
              note,
            })
            if (result.status === "rejected")
              throw Object.assign(new Error(problemasPedido(result.problems)), { code: "review" })
          }}
        />
      ) : null}
      {session ? (
        <HistorialPedido
          scope={scope}
          kind="sessionId"
          id={session.id}
          active={sessionIsOpen(session.status)}
        />
      ) : null}
    </div>
  )
}
