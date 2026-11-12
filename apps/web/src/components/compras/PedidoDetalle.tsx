"use client"

import type { PurchaseOrderWithId } from "@llenamos/core"
import { useState } from "react"
import { toast } from "sonner"
import { Notice } from "@/components/common/notice"
import { TextareaField } from "@/components/common/form-fields"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { useAlbaranes, type Scope } from "@/lib/compras/datos"
import { euros } from "@/lib/compras/dinero"
import { cantidadFormato, pendienteDePedido } from "@/lib/compras/modelo"
import { fechaLarga } from "@/lib/compras/texto"
import { useOperacion } from "@/lib/compras/useOperacion"
import { formatFull } from "@/lib/format"
import { EstadoPedido } from "./EstadoPedido"
import { RecepcionForm, ResultadoRecepcion, type Recepcion } from "./RecepcionForm"
import { TextoPedido } from "./TextoPedido"
import type { Base } from "./lecturas"

type Vista = "detalle" | "texto" | "recibir" | "resultado"
type Cambio = "sent" | "cancelled" | "closed"

const MOTIVO: Record<Exclude<Cambio, "sent">, { titulo: string; texto: string; boton: string; etiqueta: string }> = {
  cancelled: {
    titulo: "Anular el pedido",
    texto: "Un pedido anulado no se puede reabrir. Solo se puede anular si no se ha recibido nada.",
    boton: "Anular pedido",
    etiqueta: "Motivo de la anulación",
  },
  closed: {
    titulo: "Cerrar sin completar",
    texto: "Lo recibido se queda en el almacén. Lo que falta se da por perdido y ya no cuenta como pedido en camino.",
    boton: "Cerrar sin completar",
    etiqueta: "Motivo del cierre",
  },
}

export function PedidoDetalle({ scope, base, pedido, onClose, onEditar }: { scope: Scope; base: Base; pedido: PurchaseOrderWithId; onClose: () => void; onEditar: () => void }) {
  const { restaurant, location } = usePanel()
  const proveedor = base.proveedorPorId.get(pedido.supplierId)
  const albaranes = useAlbaranes(scope, pedido.id)
  const [vista, setVista] = useState<Vista>("detalle")
  const [recepcion, setRecepcion] = useState<Recepcion | null>(null)
  const [confirmarEnvio, setConfirmarEnvio] = useState(false)
  const [motivo, setMotivo] = useState<Exclude<Cambio, "sent"> | null>(null)
  const [texto, setTexto] = useState("")
  const op = useOperacion()
  const { formats: faltan, cents: faltanCents } = pendienteDePedido(pedido)
  const hayRecepciones = pedido.lines.some((l) => l.receivedFormats > 0)
  const abierto = pedido.status === "sent" || pedido.status === "partially_received"

  async function cambiar(to: Cambio, reason: string | null) {
    const out = await op.run("cambiarEstadoPedidoProveedor", { ...scope, orderId: pedido.id, expectedRevision: pedido.revision, to, reason })
    if (!out) return false
    toast.success(to === "sent" ? `Pedido ${pedido.reference} marcado como enviado` : to === "cancelled" ? `Pedido ${pedido.reference} anulado` : `Pedido ${pedido.reference} cerrado sin completar`)
    return true
  }

  const lista = albaranes.status === "ready" ? albaranes.data.toSorted((a, b) => b.receivedAt - a.receivedAt) : []

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="gap-1 border-b pb-4">
          <SheetTitle className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xl">
            <span>Pedido <span className="cifra">{pedido.reference}</span></span>
            <EstadoPedido status={pedido.status} />
          </SheetTitle>
          <SheetDescription>
            {proveedor?.name ?? "Proveedor borrado"}
            {pedido.expectedOn ? ` · entrega esperada el ${fechaLarga(pedido.expectedOn)}` : ""}
            {pedido.sentAt ? ` · enviado el ${formatFull(new Date(pedido.sentAt))}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 p-4">
          {vista === "recibir" ? (
            <RecepcionForm
              scope={scope}
              base={base}
              modo={{ tipo: "pedido", pedido }}
              onCancel={() => setVista("detalle")}
              onDone={(r) => {
                setRecepcion(r)
                setVista("resultado")
              }}
            />
          ) : vista === "resultado" && recepcion ? (
            <ResultadoRecepcion scope={scope} base={base} out={recepcion} pedido={pedido} onClose={() => setVista("detalle")} />
          ) : (
            <>
              {pedido.status === "partially_received" ? (
                <Notice tone="warning" title={`Faltan ${faltan} ${faltan === 1 ? "formato" : "formatos"} por recibir`}>
                  Unos {euros(faltanCents)} sin IVA a precio de pedido. Recíbelos cuando lleguen o cierra el pedido sin completar.
                </Notice>
              ) : null}
              {pedido.status === "draft" ? (
                <Notice tone="info">Es un borrador: el proveedor no sabe nada de él. Copia el texto, haz el pedido por tu canal y márcalo como enviado.</Notice>
              ) : null}
              {(pedido.status === "cancelled" || pedido.status === "closed") && pedido.closedReason ? (
                <Notice tone="info" title={pedido.status === "cancelled" ? "Pedido anulado" : "Cerrado sin completar"}>
                  {pedido.closedReason}
                </Notice>
              ) : null}

              <section aria-label="Líneas del pedido">
                <h3 className="mb-2 text-base font-semibold">Líneas</h3>
                <ul className="divide-y rounded-lg border">
                  {pedido.lines.map((l) => {
                    const ing = base.ingredientePorId.get(l.ingredientId)
                    const falta = Math.max(0, l.orderedFormats - l.receivedFormats)
                    return (
                      <li key={l.lineId} className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-3.5 py-3">
                        <div className="min-w-0">
                          <p className="text-[15px] font-medium">{l.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {ing?.name ?? ""} {ing ? <>· <span className="cifra">{cantidadFormato(l.baseQuantity, ing.unit)}</span></> : null} · <span className="cifra">{euros(l.priceCents)}</span> el formato
                          </p>
                        </div>
                        <p className="cifra text-right text-[15px]">{euros(l.orderedFormats * l.priceCents)}</p>
                        <p className="col-span-2 text-xs text-muted-foreground">
                          Pedido <span className="cifra text-soft-foreground">{l.orderedFormats}</span> · recibido <span className="cifra text-soft-foreground">{l.receivedFormats}</span>
                          {l.receivedFormats > l.orderedFormats ? (
                            <span className="text-warning"> · de más {l.receivedFormats - l.orderedFormats}</span>
                          ) : abierto || pedido.status === "closed" ? (
                            <> · falta <span className={falta > 0 ? "cifra text-warning" : "cifra text-soft-foreground"}>{falta}</span></>
                          ) : null}
                        </p>
                      </li>
                    )
                  })}
                </ul>
                <p className="mt-3 flex items-baseline justify-between text-sm">
                  <span className="text-muted-foreground">Total pedido sin IVA</span>
                  <span className="cifra text-lg font-semibold">{euros(pedido.totalCents)}</span>
                </p>
                {pedido.notes ? <p className="mt-2 text-sm text-muted-foreground">Nota: {pedido.notes}</p> : null}
              </section>

              {lista.length > 0 ? (
                <section aria-label="Albaranes recibidos">
                  <h3 className="mb-2 text-base font-semibold">Albaranes</h3>
                  <ul className="divide-y rounded-lg border">
                    {lista.map((a) => (
                      <li key={a.id} className="px-3.5 py-3 text-sm">
                        <p className="flex flex-wrap items-baseline justify-between gap-2">
                          <span>
                            {formatFull(new Date(a.receivedAt))}
                            {a.deliveryNote ? <> · albarán <span className="cifra">{a.deliveryNote}</span></> : null}
                          </span>
                          <span className="cifra font-medium">{euros(a.totalCents)}</span>
                        </p>
                        <ul className="mt-1 text-xs text-muted-foreground">
                          {a.lines.map((l) => (
                            <li key={l.supplierItemId}>
                              <span className="cifra">{l.receivedFormats}</span> × {base.formatoPorId.get(l.supplierItemId)?.name ?? "formato"} a <span className="cifra">{euros(l.priceCents)}</span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {vista === "texto" && proveedor ? (
                <TextoPedido pedido={pedido} proveedor={proveedor} base={base} restaurante={restaurant.name} local={location?.name ?? ""} hayRecepciones={hayRecepciones} />
              ) : null}
              {op.error ? <Notice tone="error">{op.error}</Notice> : null}
            </>
          )}
        </div>

        {vista === "detalle" || vista === "texto" ? (
          <SheetFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t p-4">
            {pedido.status === "draft" ? (
              <>
                <Button type="button" variant="ghost" size="lg" onClick={() => setMotivo("cancelled")}>Anular</Button>
                <Button type="button" variant="outline" size="lg" onClick={onEditar}>Editar</Button>
              </>
            ) : null}
            {pedido.status === "sent" ? (
              <Button type="button" variant="ghost" size="lg" onClick={() => setMotivo("cancelled")}>Anular</Button>
            ) : null}
            {pedido.status === "partially_received" ? (
              <Button type="button" variant="outline" size="lg" onClick={() => setMotivo("closed")}>Cerrar sin completar</Button>
            ) : null}
            <Button type="button" variant="outline" size="lg" onClick={() => setVista(vista === "texto" ? "detalle" : "texto")}>
              {vista === "texto" ? "Ocultar texto" : "Texto del pedido"}
            </Button>
            {pedido.status === "draft" ? (
              <Button type="button" size="lg" onClick={() => setConfirmarEnvio(true)}>Marcar como enviado</Button>
            ) : null}
            {abierto ? (
              <Button type="button" size="lg" onClick={() => setVista("recibir")}>
                {pedido.status === "sent" ? "Recibir mercancía" : "Recibir más"}
              </Button>
            ) : null}
          </SheetFooter>
        ) : null}
      </SheetContent>

      <Dialog open={confirmarEnvio} onOpenChange={(o) => !op.busy && setConfirmarEnvio(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>¿Ya has hecho este pedido?</DialogTitle>
            <DialogDescription>
              Llenamos no envía nada al proveedor. Marca el pedido como enviado solo cuando lo hayas pedido tú por teléfono, WhatsApp o correo. Desde ese momento ya no se puede editar y cuenta como mercancía en camino.
            </DialogDescription>
          </DialogHeader>
          {op.error ? <Notice tone="error">{op.error}</Notice> : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" size="lg" onClick={() => setConfirmarEnvio(false)} disabled={op.busy}>
              Todavía no
            </Button>
            <Button
              type="button"
              size="lg"
              disabled={op.busy}
              onClick={async () => {
                if (await cambiar("sent", null)) setConfirmarEnvio(false)
              }}
            >
              {op.busy ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
              Sí, ya lo he enviado
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={motivo !== null}
        onOpenChange={(o) => {
          if (op.busy) return
          if (!o) {
            setMotivo(null)
            setTexto("")
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          {motivo ? (
            <>
              <DialogHeader>
                <DialogTitle>{MOTIVO[motivo].titulo}</DialogTitle>
                <DialogDescription>{MOTIVO[motivo].texto}</DialogDescription>
              </DialogHeader>
              <TextareaField label={MOTIVO[motivo].etiqueta} value={texto} onChange={(e) => setTexto(e.target.value)} maxLength={200} rows={2} />
              {op.error ? <Notice tone="error">{op.error}</Notice> : null}
              <DialogFooter className="gap-2">
                <Button type="button" variant="ghost" size="lg" onClick={() => setMotivo(null)} disabled={op.busy}>
                  Volver
                </Button>
                <Button
                  type="button"
                  size="lg"
                  variant="destructive"
                  disabled={op.busy || texto.trim() === ""}
                  onClick={async () => {
                    if (await cambiar(motivo, texto.trim())) {
                      setMotivo(null)
                      setTexto("")
                    }
                  }}
                >
                  {op.busy ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
                  {MOTIVO[motivo].boton}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </Sheet>
  )
}

