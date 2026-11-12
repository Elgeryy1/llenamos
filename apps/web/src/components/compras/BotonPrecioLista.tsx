"use client"

import type { SupplierItemWithId } from "@llenamos/core"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import type { Scope } from "@/lib/compras/datos"
import { euros } from "@/lib/compras/dinero"
import { useOperacion } from "@/lib/compras/useOperacion"

/** Pasa el precio de lista de un formato a un precio nuevo (normalmente el último pagado). El servidor lo valida y lo guarda. */
export function BotonPrecioLista({ scope, item, cents, className }: { scope: Scope; item: SupplierItemWithId; cents: number; className?: string }) {
  const op = useOperacion()
  if (item.priceCents === cents) return null
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={className}
        disabled={op.busy}
        onClick={async () => {
          const out = await op.run("guardarFormatoProveedor", {
            ...scope,
            itemId: item.id,
            item: {
              supplierId: item.supplierId,
              ingredientId: item.ingredientId,
              name: item.name,
              sku: item.sku,
              baseQuantity: item.baseQuantity,
              priceCents: cents,
              preferred: item.preferred,
              active: item.active,
            },
          })
          if (out) toast.success(`Precio de lista de ${item.name} actualizado a ${euros(cents)}`)
        }}
      >
        {op.busy ? "Guardando…" : `Poner ${euros(cents)} como precio de lista`}
      </Button>
      {op.error ? (
        <span role="alert" className="text-xs text-destructive">
          {op.error}
        </span>
      ) : null}
    </>
  )
}
