"use client"

import {
  SESSION_TRANSITIONS,
  TABLE_SESSION_STATUS_LABEL,
  can,
  hasModule,
  sessionIsOpen,
  type TableSessionWithId,
} from "@llenamos/core"
import { useState } from "react"
import { Desplegable } from "@/components/common/desplegable"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { llamarSala } from "@/lib/comandero/callables"
import { useDestino, type Alcance } from "@/lib/comandero/datos"
import { useMembers, useSala } from "@/lib/data/hooks"
import type { TableDoc } from "@/lib/data/parse"
import { useDayReservations, useReservationSettings } from "@/lib/data/reservas"
import { usePanel } from "@/components/panel/PanelContext"
import { localDate } from "@/lib/reservas/dia"
import { useNow } from "@/lib/reservas/hooks"
import { EstadoLectura, useOperacion } from "./Servicio"

export function ElegirMesas({
  tables,
  ids,
  onChange,
}: {
  tables: TableDoc[]
  ids: string[]
  onChange: (ids: string[]) => void
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">
        Mesas elegidas: {ids.length}
      </legend>
      <div className="flex flex-wrap gap-2">
        {tables
          .filter((t) => t.enabled)
          .map((t) => (
            <Button
              type="button"
              key={t.id}
              className="h-12 min-w-14"
              variant="outline"
              aria-pressed={ids.includes(t.id)}
              onClick={() =>
                onChange(
                  ids.includes(t.id)
                    ? ids.filter((id) => id !== t.id)
                    : [...ids, t.id],
                )
              }
            >
              {ids.includes(t.id) ? "✓ " : ""}
              {t.name} · {t.seats}
            </Button>
          ))}
      </div>
    </fieldset>
  )
}

export function AbrirMesa({
  scope,
  initialTableId,
  onOpened,
}: {
  scope: Alcance
  initialTableId?: string
  onOpened: (id: string, warning: string | null) => void
}) {
  const { restaurant, role } = usePanel()
  const sala = useSala(scope.restaurantId, scope.locationId)
  const [ids, setIds] = useState<string[]>(
    initialTableId ? [initialTableId] : [],
  )
  const [guests, setGuests] = useState(2)
  const [reservationId, setReservationId] = useState("ninguna")
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [notes, setNotes] = useState("")
  const now = useNow()
  const today = localDate(now, restaurant.timezone)
  // Las reservas del día salen de la misma lectura que la agenda (API en VPS, emuladores en demo).
  const withReservations = hasModule(restaurant, "reservations") && can(role, "reservas.gestionar")
  const settings = useReservationSettings(scope.restaurantId, scope.locationId, restaurant.timezone, withReservations)
  const day = useDayReservations(scope.restaurantId, withReservations ? scope.locationId : null, today, settings.status === "ready" ? settings.data.config : null)
  const reservations = settings.status === "error" ? settings : day
  const op = useOperacion()
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void op.run(async () => {
          const result = await llamarSala("abrirMesa", {
            ...scope,
            tableIds: ids,
            guests,
            reservationId: reservationId === "ninguna" ? null : reservationId,
            guest:
              reservationId === "ninguna" && (name.trim() || phone.trim())
                ? { name, phone }
                : null,
            notes,
          })
          onOpened(
            result.sessionId,
            result.joinable
              ? null
              : "Estas mesas no están previstas para juntarse en el plano. El servidor ha confirmado la apertura.",
          )
          return result.reservationSeated
            ? "Reserva sentada y mesa abierta."
            : "Mesa abierta."
        })
      }}
    >
      {withReservations ? (
        <EstadoLectura live={reservations} label="las reservas para sentar">
          {(data) => (
            <label className="block text-sm">
              Reserva
              <Desplegable
                className="min-h-12"
                value={reservationId}
                onChange={(e) => {
                  setReservationId(e.target.value)
                  const r = data.find((r) => r.id === e.target.value)
                  if (r) {
                    setIds(r.tableIds)
                    setGuests(r.partySize)
                  }
                }}
              >
                <option value="ninguna">Sin reserva</option>
                {data
                  .filter(
                    (r) => ["pending", "confirmed", "seated", "no_show"].includes(r.status) && localDate(r.startAt, restaurant.timezone) === today,
                  )
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.guestName} · {r.partySize} personas
                    </option>
                  ))}
              </Desplegable>
            </label>
          )}
        </EstadoLectura>
      ) : null}
      <EstadoLectura live={sala} label="las mesas">
        {(data) => (
          <ElegirMesas tables={data.tables} ids={ids} onChange={setIds} />
        )}
      </EstadoLectura>
      <label className="block text-sm">
        Comensales
        <Input
          className="h-12"
          type="number"
          min={1}
          max={200}
          value={guests}
          onChange={(e) => setGuests(Number(e.target.value))}
        />
      </label>
      {reservationId === "ninguna" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Cliente opcional
            <Input
              className="h-12"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="text-sm">
            Teléfono del cliente
            <Input
              className="h-12"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
        </div>
      ) : null}
      <label className="block text-sm">
        Notas privadas de sala
        <Textarea
          maxLength={500}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      {op.feedback}
      <Button
        className="h-12 w-full"
        type="submit"
        disabled={
          op.busy ||
          !ids.length ||
          ids.length > 8 ||
          !Number.isInteger(guests) ||
          guests < 1 ||
          guests > 200 ||
          sala.status !== "ready"
        }
      >
        {op.busy
          ? "Abriendo…"
          : reservationId === "ninguna"
            ? "Abrir mesa"
            : "Sentar reserva y abrir mesa"}
      </Button>
    </form>
  )
}

export function GestionMesa({
  scope,
  session,
}: {
  scope: Alcance
  session: TableSessionWithId
}) {
  const sala = useSala(scope.restaurantId, scope.locationId)
  const members = useMembers(scope.restaurantId)
  const { lines } = useDestino(scope, "sessionId", session.id)
  const [mode, setMode] = useState("editar")
  const [ids, setIds] = useState<string[]>([])
  const [lineIds, setLineIds] = useState<string[]>([])
  const [guests, setGuests] = useState(session.guests)
  const [waiter, setWaiter] = useState(session.waiterUid ?? "nadie")
  const [notes, setNotes] = useState(session.notes)
  const [reason, setReason] = useState("")
  const [ack, setAck] = useState(false)
  const op = useOperacion()
  const active = sessionIsOpen(session.status)
  async function submit() {
    if (mode === "editar")
      await llamarSala("editarMesa", {
        ...scope,
        sessionId: session.id,
        guests,
        waiterUid: waiter === "nadie" ? null : waiter,
        notes,
      })
    if (mode === "mover")
      await llamarSala("moverMesa", {
        ...scope,
        sessionId: session.id,
        tableIds: ids,
      })
    if (mode === "juntar") {
      const r = await llamarSala("juntarMesas", {
        ...scope,
        sessionId: session.id,
        tableIds: ids,
      })
      return r.joinable
        ? "Mesas juntadas. El cliente de esta sesión recibe el consumo conjunto."
        : "Mesas juntadas, aunque el plano no prevé esta unión. El cliente de esta sesión recibe el consumo conjunto."
    }
    if (mode === "separar")
      await llamarSala("separarMesas", {
        ...scope,
        sessionId: session.id,
        tableIds: ids,
        lineIds,
        ...(lineIds.length ? { guests } : {}),
      })
    return "Mesa actualizada por el servidor."
  }
  return (
    <details className="superficie p-4">
      <summary className="min-h-12 cursor-pointer content-center font-semibold">
        Gestionar {session.label}
      </summary>
      <div className="space-y-4 pt-4">
        {op.feedback}
        <p className="text-sm text-muted-foreground">
          {TABLE_SESSION_STATUS_LABEL[session.status]} · {session.guests}{" "}
          personas · {session.waiterName ?? "Sin responsable"}
        </p>
        {active ? (
          <>
            <Desplegable
              className="min-h-12"
              aria-label="Operación de mesa"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value)
                setIds([])
                setLineIds([])
                setAck(false)
              }}
            >
              <option value="editar">Comensales, responsable y notas</option>
              <option value="mover">Mover a otras mesas</option>
              <option value="juntar">Juntar con otras mesas</option>
              <option value="separar">Separar mesas y platos</option>
            </Desplegable>
            {mode === "editar" ? (
              <>
                <label className="block text-sm">
                  Responsable
                  <Desplegable
                    className="min-h-12"
                    value={waiter}
                    onChange={(e) => setWaiter(e.target.value)}
                  >
                    <option value="nadie">Sin responsable</option>
                    {members.status === "ready"
                      ? members.data
                          .filter(
                            (m) =>
                              m.active &&
                              ["owner", "manager", "waiter"].includes(m.role) &&
                              (!m.locationIds.length ||
                                m.locationIds.includes(scope.locationId)),
                          )
                          .map((m) => (
                            <option key={m.uid} value={m.uid}>
                              {m.displayName}
                            </option>
                          ))
                      : null}
                  </Desplegable>
                </label>
                {members.status === "error" ? (
                  <Notice tone="warning">
                    No se puede leer el equipo. Conserva el responsable o vuelve
                    a cargar.
                  </Notice>
                ) : null}
                <label className="block text-sm">
                  Notas privadas
                  <Textarea
                    maxLength={500}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <EstadoLectura live={sala} label="las mesas">
                {(data) => (
                  <ElegirMesas
                    tables={
                      mode === "separar"
                        ? data.tables.filter((t) =>
                            session.tableIds.includes(t.id),
                          )
                        : data.tables.filter(
                            (t) => !session.tableIds.includes(t.id),
                          )
                    }
                    ids={ids}
                    onChange={setIds}
                  />
                )}
              </EstadoLectura>
            )}
            {mode === "juntar" ? (
              <Notice tone="warning">
                Se absorbe entera cualquier sesión de las mesas elegidas, con
                sus platos y tareas. El cliente de {session.label} recibe el
                consumo de todos los grupos, aunque tengan clientes distintos.
                <label className="mt-2 flex min-h-12 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck(e.target.checked)}
                  />
                  He comprobado los grupos y la atribución del consumo
                </label>
              </Notice>
            ) : null}
            {mode === "separar" ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Sin platos, las mesas elegidas quedan libres. Con platos, se
                  abre otra sesión del mismo cliente. Debe quedar alguna mesa en
                  la sesión original.
                </p>
                <EstadoLectura live={lines} label="los platos para separar">
                  {(data) => (
                    <fieldset>
                      <legend className="text-sm font-medium">
                        Platos que pasan a la nueva mesa
                      </legend>
                      {data
                        .filter(
                          (l) =>
                            l.kind !== "menu_component" &&
                            l.status !== "pending" &&
                            l.status !== "cancelled",
                        )
                        .map((l) => (
                          <label
                            className="flex min-h-12 items-center gap-2"
                            key={l.id}
                          >
                            <input
                              type="checkbox"
                              checked={lineIds.includes(l.id)}
                              onChange={(e) =>
                                setLineIds(
                                  e.target.checked
                                    ? [...lineIds, l.id]
                                    : lineIds.filter((id) => id !== l.id),
                                )
                              }
                            />
                            {l.quantity} × {l.name.es}
                            {l.kind === "menu"
                              ? " con todos sus componentes"
                              : ""}
                          </label>
                        ))}
                    </fieldset>
                  )}
                </EstadoLectura>
              </>
            ) : null}
            {mode === "editar" || (mode === "separar" && lineIds.length > 0) ? (
              <label className="block text-sm">
                {mode === "editar"
                  ? "Comensales"
                  : "Comensales de la nueva mesa"}
                <Input
                  type="number"
                  className="h-12"
                  min={1}
                  max={mode === "separar" ? session.guests - 1 : 200}
                  value={guests}
                  onChange={(e) => setGuests(Number(e.target.value))}
                />
              </label>
            ) : null}
            <Button
              variant="outline"
              className="h-12"
              disabled={
                op.busy ||
                (mode !== "editar" && (!ids.length || ids.length > 8)) ||
                (mode === "juntar" && !ack) ||
                (mode === "separar" &&
                  (ids.length >= session.tableIds.length ||
                    (lineIds.length > 0 &&
                      (guests < 1 || guests >= session.guests))))
              }
              onClick={() => void op.run(submit)}
            >
              Confirmar cambio
            </Button>
          </>
        ) : null}
        <div className="space-y-3 border-t pt-4">
          <label className="block text-sm">
            Motivo de cambio de estado
            <Input
              className="h-12"
              maxLength={200}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Cerrar exige todos los platos servidos o anulados y ningún pedido
            por aceptar. Registra consumo, no un pago. Reabrir retira la
            aportación de consumo del cliente.
          </p>
          <div className="flex flex-wrap gap-2">
            {SESSION_TRANSITIONS[session.status]
              .filter((s) => s !== "merged")
              .map((status) => (
                <Button
                  className="h-12"
                  variant="outline"
                  key={status}
                  disabled={
                    op.busy || (status === "cancelled" && !reason.trim())
                  }
                  onClick={() =>
                    void op.run(async () => {
                      await llamarSala("cambiarEstadoMesa", {
                        ...scope,
                        sessionId: session.id,
                        status: status as
                          | "open"
                          | "bill_requested"
                          | "closed"
                          | "cancelled",
                        reason,
                      })
                      return `Mesa ${TABLE_SESSION_STATUS_LABEL[status]}.`
                    })
                  }
                >
                  {status === "open"
                    ? active
                      ? "Volver a abierta"
                      : "Reabrir mesa"
                    : status === "closed"
                      ? "Cerrar mesa"
                      : status === "bill_requested"
                        ? "Pedir cuenta"
                        : "Anular apertura"}
                </Button>
              ))}
          </div>
        </div>
      </div>
    </details>
  )
}
