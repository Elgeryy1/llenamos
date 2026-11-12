"use client"

import { useState } from "react"
import {
  can,
  cashReconciliation,
  hasModule,
  sumCents,
  type CashSession,
} from "@llenamos/core"
import { usePanel } from "@/components/panel/PanelContext"
import { Notice } from "@/components/common/notice"
import { SummaryStrip } from "@/components/common/summary-strip"
import {
  useEquipoCaja,
  useMovimientos,
  usePagos,
  useRepartos,
  type Scope,
  type Lectura,
  type ConId,
} from "@/lib/caja/datos"
import { euros, fecha } from "@/lib/caja/modelo"
import { useHorasParaPropinas } from "@/lib/personal/datos"
import type { OperacionCaja } from "@/lib/caja/useOperacion"
import {
  Accion,
  Bloque,
  Campo,
  Formulario,
  LecturaCaja,
  Selector,
  importe,
} from "./piezas"

export function Turno({
  scope,
  op,
  sessions,
  more,
}: {
  scope: Scope
  op: OperacionCaja
  sessions: Lectura<ConId<CashSession>>
  more: () => void
}) {
  const { role, restaurant } = usePanel()
  const [registerId, setRegister] = useState(""),
    [opening, setOpening] = useState("0"),
    [selected, setSelected] = useState<string | null>(null)
  if (!can(role, "caja.gestionar"))
    return (
      <Notice>
        La apertura, el arqueo y el cierre los hace el propietario o el
        encargado. Pídele la referencia de la caja abierta para registrar los
        cobros.
      </Notice>
    )
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[0.9fr_1.4fr]">
      <div className="space-y-5">
        <Bloque title="Abrir caja">
          <Formulario
            label="Abrir caja con este fondo"
            disabled={op.blocked}
            onSubmit={() =>
              op.run(
                "abrirCaja",
                { registerId, openingCents: importe(opening) },
                () =>
                  "Caja abierta por el servidor. Ya puedes asociar cobros a este turno.",
              )
            }
          >
            <Campo
              label="Identificador de la caja"
              value={registerId}
              onChange={setRegister}
              hint="Usa siempre el mismo identificador para este terminal."
              required
            />
            <Campo
              label="Fondo inicial contado (€)"
              value={opening}
              onChange={setOpening}
              money
              required
            />
          </Formulario>
        </Bloque>
        <Bloque title="Turnos de caja">
          <LecturaCaja live={sessions} label="los turnos">
            {(rows) => (
              <>
                <ul className="divide-y">
                  {rows.map((s) => (
                    <li key={s.id}>
                      <button
                        className="min-h-20 w-full py-3 text-left"
                        onClick={() => setSelected(s.id)}
                        aria-pressed={selected === s.id}
                      >
                        <strong className="block">
                          {s.registerId} ·{" "}
                          {s.status === "open" ? "Abierta" : "Cerrada"}
                        </strong>
                        <span className="block text-xs text-muted-foreground">
                          {fecha(s.openedAt, restaurant.timezone)}
                        </span>
                        <span className="cifra text-sm">
                          Fondo {euros(s.openingCents)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                {!rows.length ? (
                  <p className="text-sm text-muted-foreground">
                    Todavía no hay turnos de caja.
                  </p>
                ) : null}
                <Accion onClick={more}>Ver turnos anteriores</Accion>
              </>
            )}
          </LecturaCaja>
        </Bloque>
      </div>
      <div className="min-w-0 space-y-5">
        <LecturaCaja live={sessions} label="el turno elegido">
          {(rows, fresh) => {
            const session =
              rows.find((s) => s.id === selected) ??
              rows.find((s) => s.status === "open") ??
              rows[0]
            return session ? (
              <Arqueo
                key={session.id}
                scope={scope}
                session={session}
                fresh={fresh}
                op={op}
              />
            ) : (
              <Bloque title="Arqueo">
                <p className="py-8 text-sm text-muted-foreground">
                  Abre una caja con el efectivo contado para empezar el turno.
                </p>
              </Bloque>
            )
          }}
        </LecturaCaja>
      </div>
    </div>
  )
}
function Arqueo({
  scope,
  session,
  fresh,
  op,
}: {
  scope: Scope
  session: ConId<CashSession>
  fresh: boolean
  op: OperacionCaja
}) {
  const { restaurant } = usePanel()
  const payments = usePagos(scope, "cashSessionId", session.id),
    movements = useMovimientos(scope, session.id)
  const [counted, setCounted] = useState(""),
    [reason, setReason] = useState(""),
    [confirm, setConfirm] = useState(false)
  const [kind, setKind] = useState("out"),
    [amount, setAmount] = useState(""),
    [movementReason, setMovementReason] = useState("")
  return (
    <>
      <Bloque
        title={`${session.registerId} · ${session.status === "open" ? "Arqueo del turno" : "Cierre confirmado"}`}
      >
        <p className="text-xs text-muted-foreground">
          Abierta el {fecha(session.openedAt, restaurant.timezone)}. Los cobros
          pertenecen a este turno aunque cruce la medianoche.
        </p>
        <div className="rounded-lg bg-surface-sunken p-3">
          <p className="text-xs text-muted-foreground">
            Referencia para cobrar
          </p>
          <p className="cifra mt-1 break-all text-sm select-all">
            {session.id}
          </p>
        </div>
        {session.status === "closed" ? (
          <>
            <SummaryStrip
                  className="sm:grid sm:divide-x-0 [&>div]:sm:border-b [&>div:nth-child(odd)]:sm:border-r [&>div>dd]:break-words [&>div>dd]:text-2xl [&>div>dd]:sm:text-3xl"
              label="Arqueo confirmado"
              items={[
                { label: "Esperado", value: euros(session.expectedCents!) },
                { label: "Contado", value: euros(session.countedCents!) },
                {
                  label: "Diferencia",
                  value: euros(session.differenceCents!),
                  tone: session.differenceCents ? "warning" : "success",
                },
              ]}
            />
            <p className="text-sm">{session.closeReason ?? "Sin descuadre"}</p>
          </>
        ) : null}
        <LecturaCaja live={payments} label="los cobros del turno">
          {(paid, paidFresh) => (
            <LecturaCaja live={movements} label="los movimientos de efectivo">
              {(moves, movesFresh) => {
                const preview = cashReconciliation(
                  session.openingCents,
                  paid,
                  moves,
                  0,
                )
                let countedCents: number | null = null
                try {
                  countedCents = importe(counted)
                } catch {
                  /* Se pide al cerrar. */
                }
                const difference =
                  countedCents === null
                    ? null
                    : countedCents - preview.expectedCents
                return (
                  <>
                    <SummaryStrip
                  className="sm:grid sm:divide-x-0 [&>div]:sm:border-b [&>div:nth-child(odd)]:sm:border-r [&>div>dd]:break-words [&>div>dd]:text-2xl [&>div>dd]:sm:text-3xl"
                      label="Libro del turno"
                      items={[
                        {
                          label: "Fondo inicial",
                          value: euros(session.openingCents),
                        },
                        {
                          label: "Efectivo esperado",
                          value: euros(preview.expectedCents),
                        },
                        {
                          label: "Propinas netas",
                          value: euros(
                            sumCents(
                              paid
                                .filter((p) => p.status === "succeeded")
                                .map(
                                  (p) =>
                                    (p.kind === "charge" ? 1 : -1) * p.tipCents,
                                ),
                            ),
                          ),
                        },
                      ]}
                    />
                    <p className="text-xs text-muted-foreground">
                      El esperado incluye fondo, cobros y propinas en efectivo,
                      entradas y salidas. Resta cada devolución una sola vez.
                      Las señales y tarjetas no entran en el cajón.
                    </p>
                    {moves.length ? (
                      <ul className="divide-y">
                        {moves.map((m) => (
                          <li
                            key={m.id}
                            className="flex justify-between gap-4 py-3 text-sm"
                          >
                            <span>
                              {m.kind === "in"
                                ? "Entrada"
                                : m.kind === "tip_payout"
                                  ? "Pago de reparto de propinas"
                                  : "Salida"}{" "}
                              · {m.reason}
                            </span>
                            <span className="cifra shrink-0">
                              {euros(m.amountCents)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Sin movimientos ajenos a cobros.
                      </p>
                    )}
                    {session.status === "open" ? (
                      <>
                        <Formulario
                          label="Registrar movimiento"
                          disabled={
                            op.blocked || !fresh || !paidFresh || !movesFresh
                          }
                          onSubmit={() =>
                            op.run(
                              "registrarMovimientoCaja",
                              {
                                cashSessionId: session.id,
                                kind: kind as "in" | "out",
                                amountCents: importe(amount, true),
                                reason: movementReason,
                              },
                              () => "Movimiento registrado en este turno.",
                            )
                          }
                        >
                          <Selector
                            label="Movimiento de efectivo"
                            value={kind}
                            onChange={setKind}
                            options={[
                              { value: "in", label: "Entrada de efectivo" },
                              {
                                value: "out",
                                label: "Salida, gasto o retirada",
                              },
                            ]}
                          />
                          <Campo
                            label="Importe del movimiento (€)"
                            value={amount}
                            onChange={setAmount}
                            money
                            required
                          />
                          <Campo
                            label="Motivo del movimiento"
                            value={movementReason}
                            onChange={setMovementReason}
                            required
                          />
                        </Formulario>
                        <div className="border-t pt-5">
                          <Formulario
                            label="Confirmar arqueo y cerrar caja"
                            disabled={
                              op.blocked || !fresh || !paidFresh || !movesFresh
                            }
                            onSubmit={async () => {
                              if (!confirm)
                                throw new Error(
                                  "Confirma que has contado el efectivo y quieres cerrar definitivamente.",
                                )
                              if (difference !== 0 && !reason.trim())
                                throw new Error(
                                  "Explica el motivo del descuadre.",
                                )
                              return op.run(
                                "cerrarCaja",
                                {
                                  cashSessionId: session.id,
                                  countedCents: importe(counted),
                                  reason: reason.trim() || null,
                                },
                                (r) =>
                                  `Cierre confirmado. Esperado ${euros(r.cashSession.expectedCents!)}. Diferencia ${euros(r.cashSession.differenceCents!)}.`,
                              )
                            }}
                          >
                            <Campo
                              label="Efectivo contado (€)"
                              value={counted}
                              onChange={setCounted}
                              money
                              required
                            />
                            <p className="cifra text-2xl">
                              Diferencia:{" "}
                              {difference === null
                                ? "Por contar"
                                : euros(difference)}
                            </p>
                            <Campo
                              label="Motivo del descuadre o nota del cierre"
                              value={reason}
                              onChange={setReason}
                              required={difference !== null && difference !== 0}
                            />
                            <label className="flex min-h-12 items-center gap-3 text-sm">
                              <input
                                type="checkbox"
                                checked={confirm}
                                onChange={(e) => setConfirm(e.target.checked)}
                                className="size-5 accent-primary"
                              />
                              He contado el efectivo y confirmo el cierre
                              definitivo
                            </label>
                            <Notice>
                              El cierre no se puede reabrir. El servidor
                              recalcula el arqueo y bloquea el cierre si hay
                              pagos externos pendientes.
                            </Notice>
                          </Formulario>
                        </div>
                      </>
                    ) : null}
                  </>
                )
              }}
            </LecturaCaja>
          )}
        </LecturaCaja>
      </Bloque>
      {session.status === "closed" ? (
        <Propinas scope={scope} sessionId={session.id} op={op} />
      ) : null}
    </>
  )
}
export function Propinas({
  scope,
  sessionId,
  op,
}: {
  scope: Scope
  sessionId: string
  op: OperacionCaja
}) {
  const { restaurant } = usePanel()
  const members = useEquipoCaja(scope, true),
    distributions = useRepartos(scope, sessionId)
  const conPersonal = hasModule(restaurant, "staff")
  const fichadas = useHorasParaPropinas(scope, sessionId, conPersonal)
  // Lo que el encargado ha tocado a mano manda sobre lo precargado de los fichajes.
  const [minutes, setMinutes] = useState<Record<string, string>>({})
  const precargadas: Record<string, string> =
    fichadas.status === "ready"
      ? Object.fromEntries(fichadas.data.hours.map((h) => [h.uid, String(h.minutes)]))
      : {}
  const incompletas = fichadas.status === "ready" ? fichadas.data.incomplete : []
  const sinFichajes =
    fichadas.status === "ready" && fichadas.data.hours.length === 0
  const nombre = (uid: string) =>
    members.status === "ready"
      ? (members.data.find((m) => m.id === uid)?.displayName ?? uid)
      : uid
  return (
    <Bloque title="Repartir propinas">
      {!conPersonal ? (
        <Notice>
          Este restaurante no tiene el módulo de personal, así que no hay horas
          fichadas. Introduce a mano los minutos aprobados de cada persona. El
          reparto se guarda una sola vez por caja cerrada. El pago físico se
          registra en una caja posterior.
        </Notice>
      ) : fichadas.status === "loading" ? (
        <Notice>Buscando las horas fichadas durante esta caja…</Notice>
      ) : fichadas.status === "error" ? (
        <Notice tone="warning" title="No se han podido leer las horas fichadas">
          {fichadas.message} Puedes repartir con minutos aprobados a mano.
        </Notice>
      ) : sinFichajes ? (
        <Notice tone="warning" title="No hay fichajes en esta caja">
          Nadie fichó entre la apertura y el cierre. Introduce a mano los
          minutos aprobados de cada persona.
        </Notice>
      ) : (
        <Notice>
          Los minutos vienen de lo fichado entre la apertura y el cierre de esta
          caja. Puedes cambiarlos antes de confirmar. El reparto se guarda una
          sola vez por caja cerrada. El pago físico se registra en una caja
          posterior.
        </Notice>
      )}
      {incompletas.length > 0 ? (
        <Notice tone="warning" title="Hay fichajes olvidados sin cerrar">
          {incompletas.map(nombre).join(", ")}: su fichaje quedó abierto y no
          cuenta. Pide a un encargado que lo cierre en Personal antes de
          repartir, o pon sus minutos a mano.
        </Notice>
      ) : null}
      <LecturaCaja live={distributions} label="los repartos">
        {(saved, fresh) =>
          saved.length ? (
            <ul>
              {saved.flatMap((d) =>
                d.shares.map((s) => (
                  <li
                    key={`${d.id}:${s.uid}`}
                    className="flex justify-between gap-3 py-3"
                  >
                    <span>
                      {members.status === "ready"
                        ? (members.data.find((m) => m.id === s.uid)
                            ?.displayName ?? s.uid)
                        : s.uid}{" "}
                      · {s.minutes} min
                    </span>
                    <span className="cifra">{euros(s.amountCents)}</span>
                  </li>
                )),
              )}
            </ul>
          ) : (
            <LecturaCaja live={members} label="el equipo">
              {(rows, membersFresh) => (
                <Formulario
                  label="Confirmar reparto por minutos"
                  disabled={
                    op.blocked ||
                    !fresh ||
                    !membersFresh ||
                    (conPersonal && fichadas.status === "loading")
                  }
                  onSubmit={() => {
                    const hours = rows
                      .map((m) => ({
                        uid: m.id,
                        minutes: Number(minutes[m.id] ?? precargadas[m.id] ?? 0),
                      }))
                      .filter((h) => h.minutes > 0)
                    return op.run(
                      "repartirPropinas",
                      { cashSessionId: sessionId, hours },
                      (r) =>
                        `Reparto confirmado: ${r.shares.map((s) => `${rows.find((m) => m.id === s.uid)?.displayName ?? s.uid}: ${euros(s.amountCents)}`).join("; ")}.`,
                    )
                  }}
                >
                  {rows.map((m) => (
                    <Campo
                      key={m.id}
                      label={`${m.displayName} · minutos aprobados`}
                      value={minutes[m.id] ?? precargadas[m.id] ?? "0"}
                      onChange={(v) => setMinutes({ ...minutes, [m.id]: v })}
                    />
                  ))}
                </Formulario>
              )}
            </LecturaCaja>
          )
        }
      </LecturaCaja>
    </Bloque>
  )
}
