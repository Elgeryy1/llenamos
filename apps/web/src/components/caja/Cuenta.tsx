"use client"

import { DescuentosCuenta } from "@/components/fidelizacion/DescuentosCuenta"
import { useState } from "react"
import {
  can,
  hasModule,
  restaurantModules,
  netBillLines,
  type Bill,
  type PosTarget,
  type SplitSpec,
} from "@llenamos/core"
import { usePanel } from "@/components/panel/PanelContext"
import { Notice } from "@/components/common/notice"
import { SummaryStrip } from "@/components/common/summary-strip"
import { llamarCaja, errorCaja } from "@/lib/caja/api"
import {
  useCuenta,
  useCuentas,
  useMesasCaja,
  useRecogidasCaja,
  usePartes,
  usePagos,
  type Scope,
} from "@/lib/caja/datos"
import { estadoCuenta, euros, fecha, reparto, decimal } from "@/lib/caja/modelo"
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
import { PagoMovil } from "./PagoMovil"
import { Cobro } from "./Cobro"
import { Facturacion } from "./Facturacion"
import { Devoluciones, Impresion } from "./Historial"

export function Cuentas({
  scope,
  op,
  cashSessionId,
  billId,
  setBillId,
}: {
  scope: Scope
  op: OperacionCaja
  cashSessionId: string
  billId: string | null
  setBillId: (id: string | null) => void
}) {
  const { restaurant } = usePanel()
  if (!hasModule(restaurant, "floor"))
    return (
      <Notice>
        El módulo Sala debe estar activo para consultar o cobrar cuentas de
        mesas y para llevar. El historial y las correcciones siguen disponibles.
      </Notice>
    )
  return (
    <CuentasSala
      scope={scope}
      op={op}
      cashSessionId={cashSessionId}
      billId={billId}
      setBillId={setBillId}
    />
  )
}
function CuentasSala({
  scope,
  op,
  cashSessionId,
  billId,
  setBillId,
}: {
  scope: Scope
  op: OperacionCaja
  cashSessionId: string
  billId: string | null
  setBillId: (id: string | null) => void
}) {
  const { role, restaurant } = usePanel()
  const sessions = useMesasCaja(scope),
    takeaways = useRecogidasCaja(scope),
    bills = useCuentas(scope)
  const [filter, setFilter] = useState("")
  const [kind, setKind] = useState("session")
  async function abrir(target: PosTarget) {
    const result = await op.run(
      "abrirCuenta",
      { target },
      () => "Cuenta leída del servidor. El consumo no se ha cobrado.",
    )
    if (result) setBillId(result.billId)
  }
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.7fr)]">
      <div className="space-y-5 lg:sticky lg:top-20">
        <Bloque title="Mesas y para llevar">
          <Campo
            label="Buscar mesa o cliente"
            value={filter}
            onChange={setFilter}
          />
          <Selector
            label="Tipo de cuenta"
            value={kind}
            onChange={setKind}
            options={[
              { value: "session", label: "Mesas" },
              { value: "takeaway", label: "Para llevar" },
            ]}
          />
          {kind === "session" ? (
            <LecturaCaja live={sessions} label="las mesas">
              {(rows, fresh) => (
                <ul className="divide-y">
                  {rows
                    .filter((s) =>
                      `${s.label} ${s.guestName ?? ""}`
                        .toLowerCase()
                        .includes(filter.toLowerCase()),
                    )
                    .map((s) => (
                      <li key={s.id}>
                        <button
                          className="flex min-h-20 w-full items-center justify-between gap-3 py-3 text-left hover:bg-surface-raised disabled:opacity-50"
                          disabled={
                            op.blocked || !fresh || !can(role, "caja.cobrar")
                          }
                          onClick={() =>
                            void abrir({ kind: "session", id: s.id })
                          }
                        >
                          <span>
                            <strong className="block text-base">
                              {s.label}
                            </strong>
                            <span className="text-xs text-muted-foreground">
                              {s.guestName ?? `${s.guests} personas`}
                              {s.billRequestedAt ? " · Piden la cuenta" : ""}
                            </span>
                          </span>
                          <span className="cifra shrink-0">
                            {euros(s.totalCents)}
                          </span>
                        </button>
                      </li>
                    ))}
                  {!rows.length ? (
                    <li className="py-5 text-sm text-muted-foreground">
                      No hay mesas abiertas.
                    </li>
                  ) : null}
                </ul>
              )}
            </LecturaCaja>
          ) : (
            <LecturaCaja live={takeaways} label="las recogidas">
              {(rows, fresh) => (
                <ul className="divide-y">
                  {rows
                    .filter((t) =>
                      `${t.reference} ${t.guestName}`
                        .toLowerCase()
                        .includes(filter.toLowerCase()),
                    )
                    .map((t) => (
                      <li key={t.id}>
                        <button
                          className="flex min-h-20 w-full items-center justify-between gap-3 py-3 text-left hover:bg-surface-raised disabled:opacity-50"
                          disabled={op.blocked || !fresh || !can(role, "caja.cobrar")}
                          onClick={() =>
                            void abrir({ kind: "takeaway", id: t.id })
                          }
                        >
                          <span>
                            <strong className="block">{t.guestName}</strong>
                            <span className="text-xs text-muted-foreground">
                              {t.reference} ·{" "}
                              {fecha(t.pickupAt, restaurant.timezone)}
                            </span>
                          </span>
                          <span className="cifra">{euros(t.totalCents)}</span>
                        </button>
                      </li>
                    ))}
                  {!rows.length ? (
                    <li className="py-5 text-sm text-muted-foreground">
                      No hay recogidas pendientes.
                    </li>
                  ) : null}
                </ul>
              )}
            </LecturaCaja>
          )}
          <p className="text-xs text-muted-foreground">
            Importes de consumo del servicio. Toca una fila para pedir la cuenta
            real al servidor.
          </p>
        </Bloque>
        <Bloque title="Cuentas en curso">
          <LecturaCaja live={bills} label="las cuentas">
            {(rows) => (
              <ul className="divide-y">
                {rows.map((b) => (
                  <li key={b.id}>
                    <button
                      className="min-h-16 w-full py-3 text-left"
                      aria-pressed={billId === b.id}
                      onClick={() => setBillId(b.id)}
                    >
                      <span className="block text-sm">
                        {b.target.kind === "session"
                          ? sessions.status === "ready"
                            ? (sessions.data.find((s) => s.id === b.target.id)
                                ?.label ?? "Mesa")
                            : "Mesa"
                          : "Para llevar"}{" "}
                        · {estadoCuenta[b.status]}
                      </span>
                      <span className="cifra text-lg">
                        {euros(b.totalCents - b.paidCents)} pendiente
                      </span>
                    </button>
                  </li>
                ))}
                {!rows.length ? (
                  <li className="text-sm text-muted-foreground">
                    No hay cuentas en curso.
                  </li>
                ) : null}
              </ul>
            )}
          </LecturaCaja>
        </Bloque>
      </div>
      <div className="min-w-0 space-y-5">
        {billId ? (
          <CuentaLocal
            key={billId}
            scope={scope}
            billId={billId}
            op={op}
            cashSessionId={cashSessionId}
          />
        ) : (
          <Bloque title="Elige una cuenta">
            <div className="py-12">
              <p className="text-2xl font-semibold">
                Lista para el siguiente cobro
              </p>
              <p className="mt-3 text-sm text-muted-foreground">
                Toca una mesa o una recogida. Aquí podrás repartir, cobrar y
                emitir el documento de prueba.
              </p>
            </div>
            <Notice>
              Sin STRIPE_SECRET_KEY no se cobra nada con Stripe. El datáfono
              externo se registra con su referencia después de cobrar fuera de
              Llenamos.
            </Notice>
          </Bloque>
        )}
      </div>
    </div>
  )
}
function CuentaLocal({
  scope,
  billId,
  op,
  cashSessionId,
}: {
  scope: Scope
  billId: string
  op: OperacionCaja
  cashSessionId: string
}) {
  const live = useCuenta(scope, billId),
    parts = usePartes(scope, billId),
    payments = usePagos(scope, "billId", billId)
  const { role, restaurant } = usePanel()
  const [mode, setMode] = useState("consumo")
  const [review, setReview] = useState<string | null>(null)
  return (
    <>
      <Bloque title="Cuenta del servicio">
        <Accion
          onClick={async () => {
            try {
              const r = await llamarCaja("verCuenta", { ...scope, billId })
              setReview(
                `Cuenta revisada. ${estadoCuenta[r.bill.status]}, revisión ${r.bill.revision}.`,
              )
            } catch (e) {
              setReview(errorCaja(e))
            }
          }}
        >
          Revisar cuenta en el servidor
        </Accion>
        {review ? <Notice>{review}</Notice> : null}
        <LecturaCaja live={live} label="la cuenta">
          {(rows, fresh) => {
            const bill = rows[0]
            if (!bill)
              return (
                <Notice>
                  No se encuentra esta cuenta. Vuelve a seleccionarla desde el
                  servicio.
                </Notice>
              )
            return (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="font-medium">{estadoCuenta[bill.status]}</p>
                  <span className="text-xs text-muted-foreground">
                    Revisión {bill.revision}
                  </span>
                </div>
                <SummaryStrip
                  className="sm:grid sm:divide-x-0 [&>div]:sm:border-b [&>div:nth-child(odd)]:sm:border-r [&>div>dd]:break-words [&>div>dd]:text-2xl [&>div>dd]:sm:text-3xl"
                  label="Saldo de la cuenta"
                  items={[
                    { label: "Consumo", value: euros(bill.totalCents) },
                    { label: "Cobrado", value: euros(bill.paidCents) },
                    {
                      label: "Pendiente",
                      value: euros(bill.totalCents - bill.paidCents),
                    },
                    { label: "Devuelto", value: euros(bill.refundedCents) },
                  ]}
                />
                <nav
                  className="flex flex-wrap gap-2"
                  aria-label="Operaciones de la cuenta"
                >
                  {[
                    ["consumo", "Consumo"],
                    ["repartir", "Dividir"],
                    ["cobrar", "Cobrar"],
                    ["facturar", "Facturar"],
                    ["pagos", "Cobros y devoluciones"],
                  ].map(([value, label]) => (
                    <Accion
                      key={value}
                      onClick={() => setMode(value!)}
                      primary={mode === value}
                    >
                      {label}
                    </Accion>
                  ))}
                </nav>
                {mode === "consumo" ? (
                  <>
                    <Consumo bill={bill} billId={billId} op={op} fresh={fresh} />
                    {fresh ? <DescuentosCuenta restaurantId={scope.restaurantId} locationId={scope.locationId} bill={{ ...bill, id: billId }} role={role} modules={restaurantModules(restaurant)} onBillChanged={async () => { await llamarCaja("verCuenta", { ...scope, billId }) }} /> : null}
                  </>
                ) : null}
                {mode === "consumo" ? (
                  <Impresion
                    scope={scope}
                    sourceId={billId}
                    kind="prebill"
                    op={op}
                    fresh={fresh}
                  />
                ) : null}
                {mode === "repartir" ? (
                  <Repartir bill={bill} billId={billId} op={op} fresh={fresh} />
                ) : null}
                {mode === "cobrar" || mode === "facturar" ? (
                  <LecturaCaja live={parts} label="las partes">
                    {(items, partsFresh) =>
                      items.length ? (
                        mode === "cobrar" ? (
                          <>
                          <PagoMovil bill={bill} billId={billId} parts={items} op={op} fresh={fresh && partsFresh && can(role, "caja.cobrar")} />
                          <Cobro
                            key={`${bill.revision}:${items.map((p) => p.id).join(",")}`}
                            bill={bill}
                            billId={billId}
                            parts={items}
                            op={op}
                            fresh={
                              fresh && partsFresh && can(role, "caja.cobrar")
                            }
                            cashSessionId={cashSessionId}
                          />
                          </>
                        ) : (
                          <Facturacion
                            bill={bill}
                            billId={billId}
                            parts={items}
                            op={op}
                            fresh={
                              fresh && partsFresh && can(role, "caja.cobrar")
                            }
                          />
                        )
                      ) : (
                        <Notice>
                          Primero guarda un reparto, aunque sea de una sola
                          parte, y prepara el cobro.
                        </Notice>
                      )
                    }
                  </LecturaCaja>
                ) : null}
                {mode === "pagos" ? (
                  <Devoluciones live={payments} op={op} />
                ) : null}
                {bill.status === "open" ? (
                  <Accion
                    primary
                    disabled={op.blocked || !fresh || !can(role, "caja.cobrar")}
                    onClick={() =>
                      void op.run(
                        "prepararCobro",
                        { billId, expectedRevision: bill.revision },
                        () =>
                          "Cuenta bloqueada para cobrar. El servicio ya no puede cambiar su consumo.",
                      )
                    }
                  >
                    Preparar cobro y bloquear consumo
                  </Accion>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Cobrar no sirve platos ni libera mesas. El servicio se cierra
                  desde Sala cuando corresponda.
                </p>
              </>
            )
          }}
        </LecturaCaja>
      </Bloque>
    </>
  )
}
function Consumo({
  bill,
  billId,
  op,
  fresh,
}: {
  bill: Bill
  billId: string
  op: OperacionCaja
  fresh: boolean
}) {
  const { role } = usePanel()
  const [lineId, setLine] = useState(bill.lines[0]?.lineId ?? ""),
    [kind, setKind] = useState("invitation"),
    [amount, setAmount] = useState(""),
    [reason, setReason] = useState("")
  const lines = netBillLines(bill.lines, bill.adjustments)
  return (
    <div className="space-y-5">
      <ul className="divide-y">
        {lines.map((l) => (
          <li
            key={l.lineId}
            className={`flex justify-between gap-4 py-3 ${l.parentLineId ? "pl-5 text-sm" : ""}`}
          >
            <span>
              {l.quantity} × {l.name}
              <span className="block text-xs text-muted-foreground">
                IVA {l.taxRate} %{l.guest ? ` · Comensal ${l.guest}` : ""}
              </span>
            </span>
            <span className="cifra shrink-0">{euros(l.grossCents)}</span>
          </li>
        ))}
      </ul>
      {bill.adjustments.length ? (
        <ul className="space-y-2 text-sm text-muted-foreground">
          {bill.adjustments.map((a) => (
            <li key={a.id}>
              {a.kind === "discount" ? "Descuento" : a.kind === "invitation" ? "Invitación" : "Anulación"}:{" "}
              {euros(a.amountCents)} · {a.reason}
            </li>
          ))}
        </ul>
      ) : null}
      {can(role, "caja.rectificar") && bill.status === "open" ? (
        <Formulario
          label="Confirmar ajuste con motivo"
          disabled={op.blocked || !fresh}
          onSubmit={() =>
            op.run(
              "ajustarCuenta",
              {
                billId,
                expectedRevision: bill.revision,
                lineId,
                kind: kind as "invitation" | "void",
                amountCents: importe(amount, true),
                reason,
              },
              () =>
                "Ajuste confirmado. Revisa y guarda de nuevo el reparto si ha cambiado el total.",
            )
          }
        >
          <Selector
            label="Línea a ajustar"
            value={lineId}
            onChange={setLine}
            options={lines.map((l) => ({
              value: l.lineId,
              label: `${l.name} · ${euros(l.grossCents)}`,
            }))}
          />
          <Selector
            label="Tipo de ajuste"
            value={kind}
            onChange={setKind}
            options={[
              { value: "invitation", label: "Invitación" },
              { value: "void", label: "Anulación de consumo" },
            ]}
          />
          <Campo
            label="Importe del ajuste (€)"
            value={amount}
            onChange={setAmount}
            money
            required
          />
          <Campo
            label="Motivo del ajuste"
            value={reason}
            onChange={setReason}
            required
          />
        </Formulario>
      ) : null}
      {can(role, "caja.rectificar") && bill.status === "locked" ? (
        <Formulario
          label="Desbloquear cuenta"
          disabled={op.blocked || !fresh || bill.paidCents > 0}
          onSubmit={() =>
            op.run(
              "desbloquearCuenta",
              { billId, expectedRevision: bill.revision, reason },
              () =>
                "Cuenta desbloqueada. Revisa consumo y reparto antes de volver a cobrar.",
            )
          }
        >
          <Notice>
            Solo se puede desbloquear sin cobros, facturas ni pagos pendientes.
            El servidor verifica estas condiciones.
          </Notice>
          <Campo
            label="Motivo para desbloquear"
            value={reason}
            onChange={setReason}
            required
          />
        </Formulario>
      ) : null}
    </div>
  )
}
function Repartir({
  bill,
  billId,
  op,
  fresh,
}: {
  bill: Bill
  billId: string
  op: OperacionCaja
  fresh: boolean
}) {
  const { role } = usePanel()
  const [kind, setKind] = useState<SplitSpec["kind"]>("equal"),
    [count, setCount] = useState("2"),
    [amounts, setAmounts] = useState(decimal(bill.totalCents)),
    [assignments, setAssignments] = useState<Record<string, string>>({})
  let plan: ReturnType<typeof reparto> | null = null,
    problem = ""
  try {
    plan = reparto(bill, kind, count, amounts, assignments)
  } catch (e) {
    problem = errorCaja(e)
  }
  return (
    <Formulario
      label="Guardar reparto en el servidor"
      disabled={
        op.blocked ||
        !fresh ||
        bill.status !== "open" ||
        !can(role, "caja.cobrar")
      }
      onSubmit={() => {
        if (!plan) throw new Error(problem)
        return op.run(
          "dividirCuenta",
          { billId, expectedRevision: bill.revision, split: plan.split },
          () =>
            "Reparto guardado. Los céntimos y los platos permanecen asignados a estas partes.",
        )
      }}
    >
      <Selector
        label="Cómo dividir la cuenta"
        value={kind}
        onChange={(v) => setKind(v as SplitSpec["kind"])}
        options={[
          { value: "equal", label: "Partes iguales" },
          { value: "dishes", label: "Por platos completos" },
          { value: "amount", label: "Por importes" },
        ]}
      />
      {kind !== "amount" ? (
        <Campo
          label="Número de partes"
          value={count}
          onChange={setCount}
          required
        />
      ) : (
        <Campo
          label="Importes de cada parte (€)"
          value={amounts}
          onChange={setAmounts}
          hint="Separa los importes con punto y coma. Ejemplo: 12,50; 8,25"
          required
        />
      )}
      {kind === "dishes"
        ? bill.lines
            .filter((l) => l.parentLineId === null)
            .map((l) => (
              <Selector
                key={l.lineId}
                label={`${l.quantity} × ${l.name}`}
                value={assignments[l.lineId] ?? "1"}
                onChange={(v) =>
                  setAssignments({ ...assignments, [l.lineId]: v })
                }
                options={Array.from(
                  { length: Math.min(200, Math.max(1, Number(count) || 1)) },
                  (_, i) => ({ value: String(i + 1), label: `Parte ${i + 1}` }),
                )}
              />
            ))
        : null}
      <p className="text-xs text-muted-foreground">
        Los menús se reparten con todos sus componentes. Para compartir una
        unidad, divide por importe.
      </p>
      {plan ? (
        <ul className="divide-y" aria-label="Vista previa del reparto">
          {plan.preview.map((p, i) => (
            <li key={i} className="flex justify-between py-3">
              <span>Parte {i + 1}</span>
              <span className="cifra">{euros(p.totalCents)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Notice tone="warning">{problem}</Notice>
      )}
      <p className="text-xs text-muted-foreground">
        Vista previa. El servidor vuelve a calcular y confirma el reparto sobre
        la revisión actual.
      </p>
    </Formulario>
  )
}
