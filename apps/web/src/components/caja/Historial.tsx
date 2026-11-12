"use client"

import { useState } from "react"
import { can, hasModule, type Invoice, type Payment } from "@llenamos/core"
import { usePanel } from "@/components/panel/PanelContext"
import { Notice } from "@/components/common/notice"
import {
  useFacturas,
  useHistorialPagos,
  useImpresoras,
  useImpresiones,
  usePagos,
  type Scope,
  type ConId,
  type Lectura,
} from "@/lib/caja/datos"
import {
  decimal,
  euros,
  fecha,
  estadoImpresion,
  estadoPago,
  metodoPago,
} from "@/lib/caja/modelo"
import type { OperacionCaja } from "@/lib/caja/useOperacion"
import {
  Accion,
  AvisoFiscal,
  Bloque,
  Campo,
  Formulario,
  LecturaCaja,
  Selector,
  importe,
} from "./piezas"
import { DatosCliente, clienteVacio, destinatario } from "./Facturacion"

export function Historial({
  scope,
  op,
  onCuenta,
}: {
  scope: Scope
  op: OperacionCaja
  onCuenta: (billId: string) => void
}) {
  const [kind, setKind] = useState("facturas")
  return (
    <div className="space-y-5">
      <nav aria-label="Tipo de historial" className="flex flex-wrap gap-2">
        <Accion
          primary={kind === "facturas"}
          onClick={() => setKind("facturas")}
        >
          Tickets y facturas
        </Accion>
        <Accion primary={kind === "cobros"} onClick={() => setKind("cobros")}>
          Todos los cobros
        </Accion>
      </nav>
      {kind === "facturas" ? (
        <HistorialFacturas scope={scope} op={op} />
      ) : (
        <LibroCobros scope={scope} op={op} onCuenta={onCuenta} />
      )}
    </div>
  )
}
function LibroCobros({
  scope,
  op,
  onCuenta,
}: {
  scope: Scope
  op: OperacionCaja
  onCuenta: (billId: string) => void
}) {
  const [count, setCount] = useState(50),
    [selected, setSelected] = useState<string | null>(null)
  const { restaurant } = usePanel()
  const history = useHistorialPagos(scope, count)
  const payments = usePagos(scope, "billId", selected)
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[0.9fr_1.4fr]">
      <Bloque title="Libro de cobros">
        <LecturaCaja live={history} label="el historial de cobros">
          {(rows) => (
            <>
              <ul className="divide-y">
                {rows.map((p) => (
                  <li key={p.id}>
                    <button
                      className="min-h-20 w-full py-3 text-left"
                      onClick={() => setSelected(p.billId)}
                    >
                      <strong>
                        {p.kind === "charge" ? "Cobro" : "Devolución"} ·{" "}
                        {metodoPago[p.method]}
                      </strong>
                      <span className="cifra block">
                        {euros(p.amountCents)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {estadoPago[p.status]} ·{" "}
                        {fecha(p.at, restaurant.timezone)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {!rows.length ? (
                <p className="text-sm text-muted-foreground">
                  Todavía no hay cobros registrados.
                </p>
              ) : null}
              <Accion onClick={() => setCount(count + 50)}>
                Cargar 50 movimientos anteriores
              </Accion>
            </>
          )}
        </LecturaCaja>
      </Bloque>
      <Bloque title="Cobros de la cuenta">
        {selected ? (
          <>
            <Devoluciones key={selected} live={payments} op={op} />
            {hasModule(restaurant, "floor") ? (
              <Accion onClick={() => onCuenta(selected)}>
                Ver cuenta y facturar
              </Accion>
            ) : null}
          </>
        ) : (
          <p className="py-10 text-sm text-muted-foreground">
            Elige un movimiento. Aquí se muestran todos los cobros y
            devoluciones de su cuenta, también si aún falta emitir la factura.
          </p>
        )}
      </Bloque>
    </div>
  )
}

function HistorialFacturas({ scope, op }: { scope: Scope; op: OperacionCaja }) {
  const [count, setCount] = useState(50),
    [filter, setFilter] = useState(""),
    [selected, setSelected] = useState<string | null>(null)
  const invoices = useFacturas(scope, count)
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[0.9fr_1.4fr]">
      <Bloque title="Tickets y facturas">
        <Campo
          label="Buscar número o cliente"
          value={filter}
          onChange={setFilter}
        />
        <LecturaCaja live={invoices} label="los tickets y facturas">
          {(rows) => (
            <>
              <ul className="divide-y">
                {rows
                  .filter((r) =>
                    `${r.number} ${r.recipient?.name ?? ""}`
                      .toLowerCase()
                      .includes(filter.toLowerCase()),
                  )
                  .map((r) => (
                    <li key={r.id}>
                      <button
                        className="min-h-24 w-full py-3 text-left"
                        onClick={() => setSelected(r.id)}
                        aria-pressed={selected === r.id}
                      >
                        <strong className="block break-all">{r.number}</strong>
                        <span className="text-xs text-muted-foreground">
                          {r.issueDate} · {r.type} ·{" "}
                          {r.recipient?.name ?? "Simplificada"}
                        </span>
                        <span className="cifra block text-lg">
                          {euros(r.totalCents)}
                        </span>
                        <span className="block text-xs text-warning">
                          No válido para Hacienda
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
              {!rows.length ? (
                <p className="py-8 text-sm text-muted-foreground">
                  Todavía no hay documentos. Las facturas aparecen solo después
                  de que el servidor confirme su emisión.
                </p>
              ) : null}
              <Accion onClick={() => setCount(count + 50)}>
                Cargar 50 documentos anteriores
              </Accion>
              <p className="text-xs text-muted-foreground">
                La búsqueda se aplica a los últimos {count} documentos cargados.
              </p>
            </>
          )}
        </LecturaCaja>
      </Bloque>
      <div className="min-w-0 space-y-5">
        <LecturaCaja live={invoices} label="el documento elegido">
          {(rows, fresh) => {
            const invoice = rows.find((r) => r.id === selected)
            return invoice ? (
              <Documento
                key={invoice.id}
                scope={scope}
                invoice={invoice}
                fresh={fresh}
                op={op}
              />
            ) : (
              <Bloque title="Documento de prueba">
                <p className="py-10 text-sm text-muted-foreground">
                  Elige un ticket o factura para ver su detalle, solicitar una
                  copia, devolver un cobro o registrar una corrección.
                </p>
                <AvisoFiscal />
              </Bloque>
            )
          }}
        </LecturaCaja>
      </div>
    </div>
  )
}
function Documento({
  scope,
  invoice,
  fresh,
  op,
}: {
  scope: Scope
  invoice: ConId<Invoice>
  fresh: boolean
  op: OperacionCaja
}) {
  const { role } = usePanel(),
    [mode, setMode] = useState("detalle")
  const payments = usePagos(scope, "billId", invoice.billId)
  return (
    <>
      <Bloque title={invoice.number}>
        <AvisoFiscal />
        <nav className="flex flex-wrap gap-2" aria-label="Documento">
          {[
            ["detalle", "Detalle"],
            ["pagos", "Devoluciones"],
            ["corregir", "Correcciones"],
          ].map(([value, label]) => (
            <Accion
              key={value}
              primary={mode === value}
              onClick={() => setMode(value!)}
            >
              {label}
            </Accion>
          ))}
        </nav>
        {mode === "detalle" ? (
          <>
            <div className="space-y-2 text-sm">
              <p>
                {invoice.type} · Expedición {invoice.issueDate} · Operación{" "}
                {invoice.operationDate}
              </p>
              <p className="font-semibold">{invoice.issuer.name}</p>
              <p>
                NIF {invoice.issuer.nif} · {invoice.issuer.address}
              </p>
              {invoice.recipient ? (
                <p>
                  Cliente: {invoice.recipient.name} ·{" "}
                  {invoice.recipient.address} ·{" "}
                  {invoice.recipient.identity.kind === "nif"
                    ? invoice.recipient.identity.nif
                    : invoice.recipient.identity.id}
                </p>
              ) : null}
            </div>
            <ul className="divide-y">
              {invoice.lines.map((l, i) => (
                <li key={i} className="flex justify-between gap-4 py-3 text-sm">
                  <span>
                    {l.quantity} × {l.description}
                    <span className="block text-xs text-muted-foreground">
                      IVA {l.taxRate} % · descuento {euros(l.discountCents)}
                    </span>
                  </span>
                  <span className="cifra shrink-0">{euros(l.grossCents)}</span>
                </li>
              ))}
            </ul>
            <ul className="space-y-2 text-sm">
              {invoice.taxes.map((t) => (
                <li
                  key={t.taxRate}
                  className="flex flex-wrap justify-between gap-2"
                >
                  <span>
                    IVA {t.taxRate} % · base {euros(t.baseCents)}
                  </span>
                  <span className="cifra">Cuota {euros(t.taxCents)}</span>
                </li>
              ))}
            </ul>
            <p className="cifra border-t pt-4 text-3xl font-semibold">
              Total {euros(invoice.totalCents)}
            </p>
            {invoice.correction ? (
              <Notice>
                Rectifica{" "}
                {invoice.correction.invoices.map((i) => i.number).join(", ")} ·{" "}
                {invoice.correction.reason}
              </Notice>
            ) : null}
            {invoice.replacedInvoices.length ? (
              <Notice>
                Sustituye{" "}
                {invoice.replacedInvoices.map((i) => i.number).join(", ")}. No
                supone otro cobro.
              </Notice>
            ) : null}
            <Impresion
              scope={scope}
              sourceId={invoice.id}
              kind="invoice"
              op={op}
              fresh={fresh}
            />
          </>
        ) : null}
        {mode === "pagos" ? (
          <Devoluciones live={payments} op={op} partId={invoice.partId} />
        ) : null}
        {mode === "corregir" ? (
          <Correcciones
            invoice={invoice}
            op={op}
            fresh={fresh}
            canCorrect={can(role, "caja.rectificar")}
          />
        ) : null}
      </Bloque>
    </>
  )
}
export function Devoluciones({
  live,
  op,
  partId,
}: {
  live: Lectura<ConId<Payment>>
  op: OperacionCaja
  partId?: string
}) {
  const { restaurant, role } = usePanel()
  const [selected, setSelected] = useState(""),
    [amount, setAmount] = useState("0"),
    [tip, setTip] = useState("0"),
    [reason, setReason] = useState("")
  return (
    <LecturaCaja live={live} label="los cobros y devoluciones">
      {(all, fresh) => {
        const rows = partId ? all.filter((p) => p.partId === partId) : all
        const charges = rows.filter(
          (p) => p.kind === "charge" && p.status === "succeeded",
        )
        const original = charges.find((p) => p.id === selected)
        const refunds = original
          ? rows.filter(
              (p) =>
                p.originalPaymentId === original.id &&
                ["succeeded", "pending"].includes(p.status),
            )
          : []
        const remaining = original
          ? original.amountCents -
            refunds.reduce((n, p) => n + p.amountCents, 0)
          : 0
        const remainingTip = original
          ? original.tipCents - refunds.reduce((n, p) => n + p.tipCents, 0)
          : 0
        return (
          <div className="space-y-4">
            <ul className="divide-y">
              {rows.map((p) => (
                <li key={p.id} className="py-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <strong>
                      {p.kind === "charge" ? "Cobro" : "Devolución"} ·{" "}
                      {metodoPago[p.method]}
                    </strong>
                    <span className="cifra shrink-0">
                      {euros(p.amountCents)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {estadoPago[p.status]} · Propina {euros(p.tipCents)} ·{" "}
                    {fecha(p.at, restaurant.timezone)}
                  </p>
                  {p.reason ? <p>{p.reason}</p> : null}
                </li>
              ))}
            </ul>
            {!rows.length ? (
              <p className="text-sm text-muted-foreground">
                No hay cobros confirmados en esta cuenta.
              </p>
            ) : null}
            {can(role, "caja.rectificar") && charges.length ? (
              <div className="space-y-4">
                <Selector
                  label="Cobro original a devolver"
                  value={selected}
                  onChange={(id) => {
                    setSelected(id)
                    setAmount("0")
                    setTip("0")
                  }}
                  options={charges.map((p) => ({
                    value: p.id,
                    label: `${metodoPago[p.method]} · ${euros(p.amountCents)} · ${fecha(p.at, restaurant.timezone)}`,
                  }))}
                />
              <Formulario
                label="Confirmar devolución"
                disabled={op.blocked || !fresh || !original}
                onSubmit={() => {
                  const amountCents = importe(amount),
                    tipCents = importe(tip)
                  if (amountCents > remaining || tipCents > remainingTip)
                    throw new Error(
                      "La devolución supera el consumo o la propina disponible del cobro original.",
                    )
                  return op.run(
                    "devolverCobro",
                    { paymentId: selected, amountCents, tipCents, reason },
                    (r) =>
                      r.status === "succeeded"
                        ? "Devolución confirmada. Si cambia la venta, registra también su rectificativa."
                        : r.status === "not_configured"
                          ? "Proveedor de devolución sin configurar. No se ha confirmado una devolución de dinero."
                          : "Devolución pendiente. Todavía no está confirmada; no la repitas por otra vía.",
                  )
                }}
              >
                <p className="text-sm">
                  Disponible: {euros(remaining)} de consumo y{" "}
                  {euros(remainingTip)} de propina.
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Campo
                    label="Consumo a devolver (€)"
                    value={amount}
                    onChange={setAmount}
                    money
                    required
                  />
                  <Campo
                    label="Propina a devolver (€)"
                    value={tip}
                    onChange={setTip}
                    money
                    required
                  />
                </div>
                <Accion
                  onClick={() => {
                    setAmount(decimal(remaining))
                    setTip("0")
                  }}
                >
                  Todo el consumo disponible
                </Accion>
                <Campo
                  label="Motivo de la devolución"
                  value={reason}
                  onChange={setReason}
                  required
                />
                <Notice>
                  La propina se devuelve solo si la indicas. Devolver no reabre
                  la cuenta ni sustituye su rectificativa fiscal. Una señal o
                  Stripe puede requerir una devolución externa pendiente.
                </Notice>
              </Formulario>
              </div>
            ) : null}
          </div>
        )
      }}
    </LecturaCaja>
  )
}
function Correcciones({
  invoice,
  op,
  fresh,
  canCorrect,
}: {
  invoice: ConId<Invoice>
  op: OperacionCaja
  fresh: boolean
  canCorrect: boolean
}) {
  const [client, setClient] = useState(clienteVacio),
    [action, setAction] = useState(
      invoice.type === "F2" ? "sustituir" : "rectificar",
    ),
    [reason, setReason] = useState(""),
    [mode, setMode] = useState("I"),
    [type, setType] = useState(invoice.type === "F2" ? "R5" : "R4"),
    [reductions, setReductions] = useState<Record<number, string>>({}),
    [confirmed, setConfirmed] = useState(false)
  return (
    <div className="space-y-4">
      <Selector
        label="Corrección a registrar"
        value={action}
        onChange={setAction}
        options={[
          ...(invoice.type === "F2"
            ? [
                {
                  value: "sustituir",
                  label: "Sustituir simplificada por factura con cliente",
                },
              ]
            : []),
          ...(canCorrect
            ? [
                { value: "rectificar", label: "Rectificar una venta real" },
                {
                  value: "anular",
                  label: "Anular una emisión que no debió existir",
                },
              ]
            : []),
        ]}
      />
      {action === "sustituir" && invoice.type === "F2" ? (
        <Formulario
          label="Emitir factura de sustitución"
          disabled={op.blocked || !fresh}
          onSubmit={() =>
            op.run(
              "sustituirSimplificada",
              { invoiceId: invoice.id, recipient: destinatario(client) },
              (r) =>
                `Factura de sustitución ${r.number}. No válido para Hacienda. No se ha registrado otro cobro.`,
            )
          }
        >
          <DatosCliente value={client} onChange={setClient} />
        </Formulario>
      ) : null}
      {action === "rectificar" && canCorrect ? (
        <Formulario
          label="Emitir rectificativa de prueba"
          disabled={op.blocked || !fresh || invoice.type.startsWith("R")}
          onSubmit={() => {
            const selected = invoice.lines.flatMap((_, lineIndex) => {
              const amountCents = importe(reductions[lineIndex] ?? "0")
              return amountCents ? [{ lineIndex, amountCents }] : []
            })
            return op.run(
              "rectificarFactura",
              {
                invoiceId: invoice.id,
                type: type as "R1" | "R2" | "R3" | "R4" | "R5",
                mode: mode as "I" | "S",
                reason,
                reductions: selected,
              },
              (r) =>
                `Rectificativa ${r.number}. No válido para Hacienda. La devolución de dinero se registra por separado.`,
            )
          }}
        >
          <Notice>
            Indica la reducción de cada línea original. El servidor descuenta lo
            ya rectificado y rechaza excesos. La rectificativa no devuelve
            dinero por sí sola.
          </Notice>
          <Selector
            label="Causa de rectificación"
            value={type}
            onChange={setType}
            options={[
              { value: "R1", label: "R1 · Error fundado en derecho" },
              { value: "R2", label: "R2 · Concurso" },
              { value: "R3", label: "R3 · Crédito incobrable" },
              { value: "R4", label: "R4 · Otras causas" },
              { value: "R5", label: "R5 · Factura simplificada" },
            ]}
          />
          <Selector
            label="Forma de rectificación"
            value={mode}
            onChange={setMode}
            options={[
              { value: "I", label: "Por diferencias" },
              { value: "S", label: "Por sustitución" },
            ]}
          />
          {invoice.lines.map((l, i) => (
            <Campo
              key={i}
              label={`Reducir ${l.description} (€), original ${euros(l.grossCents)}`}
              value={reductions[i] ?? "0"}
              onChange={(v) => setReductions({ ...reductions, [i]: v })}
              money
            />
          ))}
          <Campo
            label="Motivo de rectificación"
            value={reason}
            onChange={setReason}
            required
          />
        </Formulario>
      ) : null}
      {action === "anular" && canCorrect ? (
        <Formulario
          label="Registrar anulación fiscal de prueba"
          disabled={op.blocked || !fresh}
          onSubmit={() => {
            if (!confirmed)
              throw new Error(
                "Confirma que la operación no existió o se ha documentado su reversión.",
              )
            return op.run(
              "anularRegistroFiscal",
              { invoiceId: invoice.id, reason },
              () =>
                "Anulación de prueba registrada. No válido para Hacienda. Se conserva la factura y su número original.",
            )
          }}
        >
          <Notice tone="warning">
            La anulación fiscal no sustituye a rectificar una venta real.
            Documenta por qué esta factura no debió emitirse. El original se
            conserva.
          </Notice>
          <Campo
            label="Motivo de anulación fiscal"
            value={reason}
            onChange={setReason}
            required
          />
          <label className="flex min-h-12 items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="size-5 accent-primary"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            He revisado la ausencia de operación o su reversión documentada
          </label>
        </Formulario>
      ) : null}
    </div>
  )
}
export function Impresion({
  scope,
  sourceId,
  kind,
  op,
  fresh,
}: {
  scope: Scope
  sourceId: string
  kind: "invoice" | "prebill"
  op: OperacionCaja
  fresh: boolean
}) {
  const { role } = usePanel(),
    printers = useImpresoras(scope, can(role, "impresion.gestionar")),
    statuses = useImpresiones(scope, sourceId)
  const [printerId, setPrinter] = useState("")
  return (
    <div className="space-y-4 border-t pt-5">
      <p className="font-semibold">
        {kind === "invoice"
          ? "Copia del documento"
          : "Prefactura sin número fiscal"}
      </p>
      {can(role, "impresion.gestionar") ? (
        <LecturaCaja live={printers} label="las impresoras">
          {(rows) =>
            rows.length ? (
              <Selector
                label="Impresora"
                value={printerId}
                onChange={setPrinter}
                options={rows
                  .filter((p) => p.tickets)
                  .map((p) => ({ value: p.id, label: p.name }))}
              />
            ) : (
              <Notice>
                Sin impresora configurada. No se ha impreso ningún documento.
              </Notice>
            )
          }
        </LecturaCaja>
      ) : (
        <Campo
          label="Identificador de la impresora"
          value={printerId}
          onChange={setPrinter}
          hint="Pídelo al encargado. No se envían bytes ni direcciones de red desde esta pantalla."
        />
      )}
      <Accion
        disabled={op.blocked || !fresh || !printerId}
        onClick={() =>
          void op.run(
            "solicitarImpresion",
            { printerId, kind, sourceId, copy: kind === "invoice" },
            (r) =>
              r.status === "not_configured"
                ? "Sin impresora configurada. No se ha impreso."
                : "Petición en cola. Todavía no se ha confirmado la impresión.",
          )
        }
      >
        {kind === "invoice" ? "Solicitar copia" : "Solicitar prefactura"}
      </Accion>
      <LecturaCaja live={statuses} label="el estado de impresión">
        {(rows) => (
          <ul className="space-y-2 text-sm">
            {!rows.length ? (
              <li>No hay confirmación de impresión para este documento.</li>
            ) : null}
            {rows.map((s) => (
              <li key={s.id}>
                {estadoImpresion[s.status]}
                {s.lastError ? ` · ${s.lastError}` : ""}
              </li>
            ))}
          </ul>
        )}
      </LecturaCaja>
      <p className="text-xs text-muted-foreground">
        Un envío incierto exige revisar la impresora. No se reenvía
        automáticamente. La copia conserva número e importes y no abre el cajón.
      </p>
    </div>
  )
}
