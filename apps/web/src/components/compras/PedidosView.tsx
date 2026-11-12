"use client"

import type { PurchaseOrderWithId } from "@llenamos/core"
import { CaretRightIcon, ClipboardTextIcon, PlusIcon } from "@phosphor-icons/react"
import Link from "next/link"
import { useMemo, useState } from "react"
import { EmptyState } from "@/components/common/empty-state"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { SegmentedControl } from "@/components/common/segmented-control"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Tag } from "@/components/common/tag"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useAlbaranes, usePedidos, type Scope } from "@/lib/compras/datos"
import { euros } from "@/lib/compras/dinero"
import { GRUPO_PEDIDO, pendienteDePedido, resumenPedidos, type GrupoPedido } from "@/lib/compras/modelo"
import { fechaLarga } from "@/lib/compras/texto"
import { formatRelative, plural } from "@/lib/format"
import { ComprasGate } from "./ComprasGate"
import { EstadoPedido } from "./EstadoPedido"
import { NavCompras } from "./NavCompras"
import { PedidoDetalle } from "./PedidoDetalle"
import { PedidoEditor, type PresetPedido } from "./PedidoEditor"
import { RecepcionForm, ResultadoRecepcion, type Recepcion } from "./RecepcionForm"
import { Sugerencias } from "./Sugerencias"
import { useBase, type Base } from "./lecturas"

export function PedidosView() {
  return <ComprasGate>{(scope, local) => <Pedidos scope={scope} local={local} />}</ComprasGate>
}

type Filtro = GrupoPedido | "todos"
type Editor = { pedido: PurchaseOrderWithId | null; preset: PresetPedido | null } | null

function Pedidos({ scope, local }: { scope: Scope; local: string }) {
  const { datos: base, error: errorBase } = useBase(scope)
  const pedidosLive = usePedidos(scope)
  const [filtro, setFiltro] = useState<Filtro>("por_recibir")
  const [detalleId, setDetalleId] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor>(null)
  const [directa, setDirecta] = useState(false)

  const pedidos = useMemo(() => (pedidosLive.status === "ready" ? pedidosLive.data.toSorted((a, b) => b.reference.localeCompare(a.reference)) : null), [pedidosLive])
  const huella = pedidos?.map((p) => `${p.id}:${p.revision}`).join("|") ?? ""
  const resumen = useMemo(() => resumenPedidos(pedidos ?? []), [pedidos])
  const visibles = pedidos?.filter((p) => filtro === "todos" || GRUPO_PEDIDO[p.status] === filtro) ?? []
  const detalle = pedidos?.find((p) => p.id === detalleId) ?? null
  const hayError = errorBase || pedidosLive.status === "error"
  const sinFormatos = base && base.formatos.filter((f) => f.active).length === 0

  const titulo = !pedidos
    ? "Compras"
    : resumen.porRecibir > 0
      ? `${plural(resumen.porRecibir, "pedido espera", "pedidos esperan")} mercancía`
      : resumen.borradores > 0
        ? `${plural(resumen.borradores, "borrador", "borradores")} por enviar`
        : "No hay pedidos en camino"

  return (
    <>
      <PageHeading
        title={titulo}
        eyebrow={local}
        description="Pide a tus proveedores, recibe la mercancía por albaranes y vigila los cambios de precio. Llenamos no envía nada: el pedido lo haces tú y lo marcas como enviado."
        actions={
          <>
            <Button variant="outline" size="lg" onClick={() => setDirecta(true)} disabled={!base}>
              Recibir sin pedido
            </Button>
            <Button size="lg" onClick={() => setEditor({ pedido: null, preset: null })} disabled={!base || base.proveedores.length === 0}>
              <PlusIcon aria-hidden /> Nuevo pedido
            </Button>
          </>
        }
      />
      <NavCompras />
      {hayError ? (
        <Notice tone="error" title="No se pueden leer las compras">
          Comprueba que tu cuenta tiene acceso a las compras de este local y que el módulo de inventario está activo.
        </Notice>
      ) : !base || !pedidos ? (
        <LoadingBlock label="Cargando compras" />
      ) : base.proveedores.length === 0 ? (
        <EmptyState
          icon={<ClipboardTextIcon />}
          title="Primero, tus proveedores"
          description="Para pedir hace falta saber a quién y en qué formatos. Da de alta un proveedor y lo que te vende."
          action={
            <Button asChild>
              <Link href="/panel/compras/proveedores">Ir a proveedores y formatos</Link>
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          <SummaryStrip
            label="Resumen de pedidos"
            items={[
              { label: "Borradores", value: resumen.borradores, hint: "sin enviar" },
              { label: "En camino", value: resumen.porRecibir, hint: "enviados, sin recibir del todo", tone: resumen.porRecibir > 0 ? "warning" : undefined },
              { label: "Recibidos en parte", value: resumen.enParte, hint: "con mercancía pendiente" },
              { label: "Pendiente de recibir", value: euros(resumen.pendienteCents), hint: "sin IVA, a precio de pedido" },
            ]}
          />
          {sinFormatos ? (
            <Notice tone="warning" title="Ningún proveedor tiene formatos activos">
              Sin formatos no se puede pedir ni sugerir. Añádelos en <Link href="/panel/compras/proveedores" className="underline underline-offset-2">proveedores y formatos</Link>.
            </Notice>
          ) : (
            <Sugerencias scope={scope} base={base} huella={huella} onCrear={(preset) => setEditor({ pedido: null, preset })} />
          )}

          <section className="superficie overflow-hidden" aria-label="Pedidos">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
              <h2 className="text-base font-semibold">Pedidos</h2>
              <SegmentedControl
                label="Mostrar pedidos"
                value={filtro}
                onValueChange={setFiltro}
                options={[
                  { value: "por_recibir", label: "En camino" },
                  { value: "borrador", label: "Borradores" },
                  { value: "cerrado", label: "Cerrados" },
                  { value: "todos", label: "Todos" },
                ]}
              />
            </div>
            {visibles.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-muted-foreground">
                {filtro === "por_recibir" ? "No hay pedidos en camino." : filtro === "borrador" ? "No hay borradores." : filtro === "cerrado" ? "Aún no hay pedidos cerrados." : "Aún no hay pedidos."}
              </p>
            ) : (
              <ul className="divide-y">
                {visibles.map((p) => (
                  <FilaPedido key={p.id} pedido={p} base={base} onAbrir={() => setDetalleId(p.id)} />
                ))}
              </ul>
            )}
          </section>

          <UltimosAlbaranes scope={scope} base={base} />
        </div>
      )}

      {detalle && base && !editor ? (
        <PedidoDetalle key={detalle.id} scope={scope} base={base} pedido={detalle} onClose={() => setDetalleId(null)} onEditar={() => setEditor({ pedido: detalle, preset: null })} />
      ) : null}
      {editor && base ? (
        <PedidoEditor
          key={editor.pedido?.id ?? "nuevo"}
          scope={scope}
          base={base}
          pedido={editor.pedido}
          preset={editor.preset}
          onClose={() => setEditor(null)}
          onSaved={(id) => {
            setEditor(null)
            setFiltro("borrador")
            setDetalleId(id)
          }}
        />
      ) : null}
      {directa && base ? <RecepcionDirecta scope={scope} base={base} onClose={() => setDirecta(false)} /> : null}
    </>
  )
}

function FilaPedido({ pedido: p, base, onAbrir }: { pedido: PurchaseOrderWithId; base: Base; onAbrir: () => void }) {
  const proveedor = base.proveedorPorId.get(p.supplierId)
  const { formats } = pendienteDePedido(p)
  const enCamino = p.status === "sent" || p.status === "partially_received"
  return (
    <li>
      <button
        type="button"
        onClick={onAbrir}
        aria-label={`Abrir el pedido ${p.reference} de ${proveedor?.name ?? "proveedor"}`}
        className="flex min-h-16 w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
      >
        <span className="cifra hidden w-[4.5rem] shrink-0 text-[15px] font-medium sm:block">{p.reference}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium sm:truncate">{proveedor?.name ?? "Proveedor borrado"}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground sm:truncate">
            <span className="cifra sm:hidden">{p.reference} · </span>
            {plural(p.lines.length, "línea", "líneas")}
            {p.expectedOn ? ` · entrega ${fechaLarga(p.expectedOn)}` : ""}
          </span>
        </span>
        <span className="hidden shrink-0 sm:block">
          <EstadoPedido status={p.status} />
          {enCamino && formats > 0 ? <span className="mt-0.5 block text-xs text-muted-foreground">faltan {plural(formats, "formato", "formatos")}</span> : null}
        </span>
        <span className="cifra w-24 shrink-0 text-right text-[15px]">{euros(p.totalCents)}</span>
        <CaretRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <div className="px-5 pb-3 sm:hidden">
        <EstadoPedido status={p.status} />
      </div>
    </li>
  )
}

function UltimosAlbaranes({ scope, base }: { scope: Scope; base: Base }) {
  const live = useAlbaranes(scope)
  const lista = live.status === "ready" ? live.data.toSorted((a, b) => b.receivedAt - a.receivedAt) : []
  if (live.status !== "ready" || lista.length === 0) return null
  return (
    <section className="superficie overflow-hidden" aria-label="Últimos albaranes">
      <h2 className="border-b px-5 py-3 text-base font-semibold">Últimos albaranes</h2>
      <ul className="divide-y">
        {lista.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{base.proveedorPorId.get(a.supplierId)?.name ?? "Proveedor borrado"}</span>
              {a.deliveryNote ? <span className="text-muted-foreground"> · albarán <span className="cifra">{a.deliveryNote}</span></span> : null}
              <span className="text-muted-foreground"> · {plural(a.lines.length, "línea", "líneas")}</span>
              {a.purchaseOrderId === null ? (
                <>
                  {" "}
                  <Tag>Sin pedido</Tag>
                </>
              ) : null}
            </span>
            <span className="flex items-baseline gap-4">
              <span className="text-xs text-muted-foreground">{formatRelative(new Date(a.receivedAt))}</span>
              <span className="cifra">{euros(a.totalCents)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function RecepcionDirecta({ scope, base, onClose }: { scope: Scope; base: Base; onClose: () => void }) {
  const [resultado, setResultado] = useState<Recepcion | null>(null)
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="gap-1 border-b pb-4">
          <SheetTitle className="text-xl">Recibir sin pedido</SheetTitle>
          <SheetDescription>Mercancía que llega sin pedido previo, como una compra en el momento. Entra en el almacén al precio del albarán.</SheetDescription>
        </SheetHeader>
        <div className="p-4">
          {resultado ? (
            <ResultadoRecepcion scope={scope} base={base} out={resultado} pedido={null} onClose={onClose} />
          ) : (
            <RecepcionForm scope={scope} base={base} modo={{ tipo: "directa" }} onCancel={onClose} onDone={(r) => setResultado(r)} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
