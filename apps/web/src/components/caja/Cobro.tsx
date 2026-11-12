"use client"

import { useConnection } from "@/lib/sin-conexion/conexion"
import { EfectivoLocal } from "@/components/sin-conexion/EfectivoLocal"
import { useState } from "react"
import { cashChange, type Bill, type BillPart } from "@llenamos/core"
import type { ConId } from "@/lib/caja/datos"
import { decimal, euros } from "@/lib/caja/modelo"
import type { OperacionCaja } from "@/lib/caja/useOperacion"
import { Notice } from "@/components/common/notice"
import { Accion, Campo, Formulario, Selector, importe } from "./piezas"

export function Cobro({
  bill,
  billId,
  parts,
  cashSessionId,
  op,
  fresh,
}: {
  bill: Bill
  billId: string
  parts: ConId<BillPart>[]
  cashSessionId: string
  op: OperacionCaja
  fresh: boolean
}) {
  const online = useConnection()
  const [selected, setSelected] = useState(parts[0]?.id ?? "")
  const part = parts.find((p) => p.id === selected)
  const due = part ? part.totalCents - part.paidCents : 0
  const [method, setMethod] = useState("cash")
  const [customAmount, setAmount] = useState<string | null>(null)
  const amount = customAmount ?? decimal(due)
  const [tip, setTip] = useState("0")
  const [tendered, setTendered] = useState("")
  const [reference, setReference] = useState("")
  const [ticket, setTicket] = useState(true)
  const [lastChange, setLastChange] = useState<number | null>(null)
  let change: number | null = null
  try {
    if (method === "cash")
      change = cashChange(
        importe(amount, true),
        importe(tip),
        importe(tendered),
      )
  } catch {
    /* El formulario explicará el importe que falta al enviar. */
  }
  const blocked =
    op.blocked ||
    !fresh || !online ||
    !part ||
    !cashSessionId ||
    bill.status !== "locked" ||
    part.revision !== bill.revision ||
    due <= 0
  return (
    <div className="space-y-4">
      <EfectivoLocal billId={billId} partId={part?.id} revision={bill.revision} cashSessionId={cashSessionId} fresh={fresh && online} amounts={() => ({ amountCents: importe(amount, true), tipCents: importe(tip), tenderedCents: importe(tendered) })} />
      <Selector
        label="Parte a cobrar"
        value={selected}
        onChange={(v) => {
          setSelected(v)
          setAmount(null)
          setLastChange(null)
          setTendered("")
        }}
        options={parts.map((p) => ({
          value: p.id,
          label: `${p.label} · pendiente ${euros(p.totalCents - p.paidCents)}`,
        }))}
      />
      <p className="text-sm text-muted-foreground">
        Para un pago mixto, registra primero una parte en efectivo y después el
        resto con tarjeta. Cada cobro queda por separado.
      </p>
      {!cashSessionId ? (
        <Notice tone="warning">
          Selecciona una caja abierta o pide su referencia al encargado antes de
          cobrar.
        </Notice>
      ) : null}
      <Formulario
        label={
          op.busy
            ? "Esperando al servidor…"
            : `Registrar ${euros(safeAmount(amount))}`
        }
        disabled={blocked}
        onSubmit={async () => {
          if (!part) return
          const amountCents = importe(amount, true),
            tipCents = importe(tip)
          if (amountCents > due)
            throw new Error(
              "El importe supera el saldo pendiente de esta parte.",
            )
          const tenderedCents = method === "cash" ? importe(tendered) : 0
          if (method === "cash")
            cashChange(amountCents, tipCents, tenderedCents)
          const response = await op.run(
            "registrarCobro",
            {
              billId,
              expectedRevision: bill.revision,
              partId: part.id,
              cashSessionId,
              method: method as "cash" | "card" | "deposit",
              amountCents,
              tipCents,
              tenderedCents,
              terminalReference: method === "card" ? reference : null,
            },
            (r) =>
              `Cobro confirmado. Cambio ${euros(r.changeCents)}. Pendiente de esta parte ${euros(r.dueCents)}.`,
          )
          if (response) {
            setLastChange(response.changeCents)
            setAmount(null)
            setTendered("")
            setTip("0")
            setReference("")
            if (response.dueCents === 0 && ticket && !part.invoiceId) {
              await op.run("emitirFactura", {
                billId, partId: part.id, expectedRevision: bill.revision,
                type: "F2", recipient: null,
              }, r => `Ticket de prueba ${r.number} en cola de impresión. No válido para Hacienda.`)
            }
          }
        }}
      >
        {!part?.invoiceId ? (
          <label className="flex min-h-12 items-center gap-3 text-sm">
            <input className="size-5 accent-primary" type="checkbox" checked={ticket} onChange={e => setTicket(e.target.checked)} />
            Emitir ticket al completar esta parte
          </label>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Para una factura completa, emítela en Facturar antes de cobrar o desmarca el ticket.
          Si la emisión falla, el cobro confirmado se conserva y puedes emitir desde Facturar.
        </p>
        <Selector
          label="Forma de pago"
          value={method}
          onChange={(value) => {
            setMethod(value)
            setLastChange(null)
          }}
          options={[
            { value: "cash", label: "Efectivo" },
            { value: "card", label: "Tarjeta con datáfono externo" },
            { value: "deposit", label: "Aplicar señal pagada" },
          ]}
        />
        {method === "card" ? (
          <Notice>
            Este botón registra un cobro ya realizado en un datáfono externo. No
            ejecuta un cargo bancario ni usa Stripe.
          </Notice>
        ) : null}
        {method === "deposit" ? (
          <Notice>
            Solo se aplica una señal realmente pagada y disponible de la
            reserva. El servidor comprueba su saldo y su evidencia fiscal.
          </Notice>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Campo
            label="Importe del consumo (€)"
            value={amount}
            onChange={(value) => {
              setAmount(value)
              setLastChange(null)
            }}
            money
            required
          />
          <Campo
            label="Propina voluntaria (€)"
            value={tip}
            onChange={(value) => {
              setTip(value)
              setLastChange(null)
            }}
            money
            required
          />
        </div>
        <Accion onClick={() => { setAmount(decimal(due)); setLastChange(null) }}>
          Todo el pendiente: {euros(due)}
        </Accion>
        {method === "cash" ? (
          <>
            <Campo
              label="Efectivo entregado (€)"
              value={tendered}
              onChange={(value) => {
                setTendered(value)
                setLastChange(null)
              }}
              money
              required
            />
            <div className="flex flex-wrap gap-2">
              {[1000, 2000, 5000, 10000].map((n) => (
                <Accion key={n} onClick={() => { setTendered(decimal(n)); setLastChange(null) }}>
                  {euros(n)}
                </Accion>
              ))}
              <Accion
                onClick={() => {
                  try {
                    setTendered(decimal(importe(amount) + importe(tip)))
                    setLastChange(null)
                  } catch {
                    /* Se valida al enviar. */
                  }
                }}
              >
                Justo
              </Accion>
            </div>
          </>
        ) : null}
        {method === "card" ? (
          <Campo
            label="Referencia del datáfono"
            value={reference}
            onChange={setReference}
            required
          />
        ) : null}
      </Formulario>
      {method === "cash" ? (
        <div
          className="rounded-xl border border-primary/30 bg-surface-sunken p-5"
          role="status"
        >
          <p className="text-sm text-muted-foreground">
            {lastChange === null
              ? "Cambio previsto"
              : "Cambio confirmado por el servidor"}
          </p>
          <p className="cifra mt-2 text-4xl font-semibold text-primary sm:text-5xl">
            {lastChange !== null
              ? euros(lastChange)
              : change === null
                ? "Falta entrega"
                : euros(change)}
          </p>
        </div>
      ) : null}
    </div>
  )
}
function safeAmount(value: string) {
  try {
    return importe(value)
  } catch {
    return 0
  }
}
