"use client"

import { CaretRightIcon, PlusIcon, TruckIcon } from "@phosphor-icons/react"
import { useState } from "react"
import { EmptyState } from "@/components/common/empty-state"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { Tag } from "@/components/common/tag"
import { LoadingBlock } from "@/components/common/loading"
import { Button } from "@/components/ui/button"
import { euros } from "@/lib/compras/dinero"
import type { Scope } from "@/lib/compras/datos"
import { plural } from "@/lib/format"
import { ComprasGate } from "./ComprasGate"
import { NavCompras } from "./NavCompras"
import { ProveedorSheet } from "./ProveedorSheet"
import { useBase } from "./lecturas"

export function ProveedoresView() {
  return <ComprasGate>{(scope, local) => <Proveedores scope={scope} local={local} />}</ComprasGate>
}

type Abierto = { id: string | null } | null

function Proveedores({ scope, local }: { scope: Scope; local: string }) {
  const { datos, error } = useBase(scope)
  const [abierto, setAbierto] = useState<Abierto>(null)
  const formatosDe = (id: string) => datos?.formatos.filter((f) => f.supplierId === id) ?? []
  const titulo = datos
    ? datos.proveedores.length === 0
      ? "Aún no tienes proveedores"
      : `${plural(datos.proveedores.length, "proveedor", "proveedores")} y ${plural(datos.formatos.length, "formato", "formatos")}`
    : "Proveedores y formatos"
  return (
    <>
      <PageHeading
        title={titulo}
        eyebrow={local}
        description="Lo que te vende cada proveedor, en el formato en que lo compras. Los precios van sin IVA."
        actions={
          <Button size="lg" onClick={() => setAbierto({ id: null })}>
            <PlusIcon aria-hidden /> Nuevo proveedor
          </Button>
        }
      />
      <NavCompras />
      {error ? (
        <Notice tone="error" title="No se pueden leer los proveedores">
          Comprueba que tu cuenta tiene acceso a las compras de este local y que el módulo de inventario está activo.
        </Notice>
      ) : !datos ? (
        <LoadingBlock label="Cargando proveedores" />
      ) : datos.proveedores.length === 0 ? (
        <EmptyState
          icon={<TruckIcon />}
          title="Aún no hay proveedores"
          description="Da de alta el primero y añade los formatos que te vende (un saco de 25 kg, una garrafa de 5 l). Con ellos podrás pedir y recibir mercancía."
          action={<Button onClick={() => setAbierto({ id: null })}>Nuevo proveedor</Button>}
        />
      ) : (
        <section className="superficie overflow-hidden" aria-label="Proveedores">
          <ul className="divide-y">
            {datos.proveedores.map((p) => {
              const fs = formatosDe(p.id)
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setAbierto({ id: p.id })}
                    className="@container/lista flex min-h-16 w-full items-center gap-4 px-5 py-3.5 text-left transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className={p.active ? "text-[15px] font-medium" : "text-[15px] font-medium text-muted-foreground"}>{p.name}</span>
                        {!p.active ? <Tag>Desactivado</Tag> : null}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {[p.contact, p.phone, p.email].filter(Boolean).join(" · ") || "Sin datos de contacto"}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-right text-xs text-muted-foreground @md/lista:block">
                      <span className="block text-soft-foreground">
                        {p.leadDays === 0 ? "Entrega el mismo día" : `Entrega en ${plural(p.leadDays, "día", "días")}`}
                      </span>
                      <span className="block">{p.minOrderCents > 0 ? `Pedido mínimo ${euros(p.minOrderCents)}` : "Sin pedido mínimo"}</span>
                    </span>
                    <span className="cifra w-24 shrink-0 text-right text-sm text-soft-foreground">{plural(fs.filter((f) => f.active).length, "formato", "formatos")}</span>
                    <CaretRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {abierto && datos ? (
        <ProveedorSheet key={abierto.id ?? "nuevo"} scope={scope} base={datos} proveedorId={abierto.id} onClose={() => setAbierto(null)} />
      ) : null}
    </>
  )
}
